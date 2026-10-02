"""
The monitors a reader follows, with their health, for the Monitors
screen and for the scope of an agent.

Health is the monitor's own `status`, written by the collector after
every fetch; the error shown is the last failed run's, while the monitor
is not healthy. A shared monitor's health is the same for every reader
who follows it.
"""
from __future__ import annotations

_SELECT = """
    SELECT m.id, m.name, m.template, m.config ->> 'url', m.config ->> 'query',
           src.domain,
           COALESCE(c.country, m.config ->> 'hl'),
           src.country,
           m.status, m.consecutive_failures, m.last_success_at, m.last_failure_at,
           CASE WHEN m.status <> 'active' THEN (
               SELECT r.error FROM monitor_runs r
                WHERE r.monitor_id = m.id AND r.outcome = 'failed'
                ORDER BY r.started_at DESC LIMIT 1)
           END,
           (SELECT count(*) FROM monitor_items mi
             WHERE mi.monitor_id = m.id AND mi.fetched_at > now() - interval '7 days'),
           (SELECT max(mi.fetched_at) FROM monitor_items mi WHERE mi.monitor_id = m.id)
      FROM subscriptions s
      JOIN monitors m       ON m.id = s.monitor_id
      LEFT JOIN catalog c   ON c.id = m.catalog_id
      LEFT JOIN sources src ON src.id = m.source_id
     WHERE s.user_id = %s
"""

# Fetches shown on a monitor's log: one day, at most every ten minutes.
RUNS_HOURS = 24
LATEST_ITEMS = 6


def _iso(value) -> str | None:
    return value.isoformat() if value else None


def _monitor(r) -> dict:
    return {
        "id": r[0],
        "name": r[1],
        "template": r[2],
        "url": r[3] or "",
        "query": r[4],
        # The publisher's site, for its favicon. None for a Google News
        # monitor, whose publisher is resolved article by article.
        "site_url": f"https://{r[5]}" if r[5] else None,
        "lang": r[6],
        "country": r[7],
        "status": r[8],
        "consecutive_failures": r[9],
        "last_success_at": _iso(r[10]),
        "last_failure_at": _iso(r[11]),
        "last_error": r[12],
        "items_7d": r[13],
        "last_item_at": _iso(r[14]),
    }


def load_reader_monitors(cur, user_id: str) -> list[dict]:
    cur.execute(_SELECT + " ORDER BY m.name", (user_id,))
    return [_monitor(r) for r in cur.fetchall()]


def load_reader_monitor(cur, user_id: str, monitor_id: int) -> dict | None:
    """One followed monitor, its fetches of the last day and its latest
    articles. None when the reader does not follow it."""
    cur.execute(_SELECT + " AND m.id = %s", (user_id, monitor_id))
    row = cur.fetchone()
    if row is None:
        return None

    cur.execute(
        f"""SELECT id, started_at, duration_ms, outcome, items_seen, items_new, error
              FROM monitor_runs
             WHERE monitor_id = %s AND started_at > now() - interval '{RUNS_HOURS} hours'
             ORDER BY started_at DESC""",
        (monitor_id,),
    )
    runs = [
        {"id": r[0], "started_at": _iso(r[1]), "duration_ms": r[2], "outcome": r[3],
         "items_seen": r[4], "items_new": r[5], "error": r[6]}
        for r in cur.fetchall()
    ]

    cur.execute(
        """SELECT i.id, i.title, i.url, COALESCE(i.published_at, i.fetched_at)
             FROM monitor_items mi
             JOIN items i ON i.id = mi.item_id
            WHERE mi.monitor_id = %s AND NOT i.archive_seed
            ORDER BY mi.fetched_at DESC, i.id DESC
            LIMIT %s""",
        (monitor_id, LATEST_ITEMS),
    )
    items = [
        {"id": r[0], "title": r[1], "url": r[2], "published_at": _iso(r[3])}
        for r in cur.fetchall()
    ]
    return {"monitor": _monitor(row), "runs": runs, "items": items}
