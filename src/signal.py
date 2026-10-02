"""
Signal: a reader's context, their watchers, and what the watchers decided.

The judging itself is a worker step (src/judge.py). This module is what
the API reads and writes on the reader's behalf; every function takes
the reader's id and touches nothing of anyone else's.

## Decisions, grouped by story moment

The Decisions screen lists stories, not verdicts: one row per story and
worker pass, with the verdict of every watcher that judged it on that
pass. An active watcher that has not is listed too, with why — the story
has no article from its monitors, its daily budget could not reach it
while it was fresh, or it is still waiting for a pass — so "dropped" and
"never looked at" do not look alike.

## Budget

Each watcher reports how much of its daily budget it used and how many
stories it skipped in the last day: a watcher that skips is missing news,
and the reader has to see it to narrow its monitors or its request.
"""
from __future__ import annotations

from collections import defaultdict

from src.judge import DAILY_BUDGET

DECISION_DAYS = 7
# Verdicts read at most, newest first. A week of a busy reader stays under it.
MAX_JUDGMENTS = 3000


def _iso(value) -> str | None:
    return value.isoformat() if value else None


# ── Context ─────────────────────────────────────────────────────────────────
def load_context(cur, user_id: str) -> dict:
    cur.execute(
        "SELECT context, context_at FROM users WHERE id = %s",
        (user_id,),
    )
    body, at = cur.fetchone()
    return {"body": body or "", "updated_at": _iso(at)}


def save_context(cur, user_id: str, body: str) -> dict:
    cur.execute(
        """UPDATE users SET context = %s, context_at = now()
            WHERE id = %s
        RETURNING context, context_at""",
        (body.strip(), user_id),
    )
    body, at = cur.fetchone()
    return {"body": body, "updated_at": _iso(at)}


# ── Watchers ──────────────────────────────────────────────────────────────────
_WATCHER_SELECT = """
    SELECT w.id, w.name, w.request, w.status, w.created_at,
           ARRAY(SELECT wm.monitor_id FROM watcher_monitors wm
                  WHERE wm.watcher_id = w.id ORDER BY wm.monitor_id),
           count(j.id) FILTER (WHERE j.verdict = 'kept'
                                 AND j.created_at > now() - make_interval(days => %(days)s)),
           count(j.id) FILTER (WHERE j.verdict = 'dropped'
                                 AND j.created_at > now() - make_interval(days => %(days)s)),
           max(j.created_at) FILTER (WHERE j.verdict = 'kept'),
           count(j.id) FILTER (WHERE j.verdict <> 'skipped'
                                 AND j.created_at > now() - interval '1 day'),
           count(j.id) FILTER (WHERE j.verdict = 'skipped'
                                 AND j.created_at > now() - interval '1 day')
      FROM watchers w
      LEFT JOIN judgments j ON j.watcher_id = w.id
"""


def _watcher_row(r) -> dict:
    return {
        "id": r[0],
        "name": r[1],
        "request": r[2],
        "status": r[3],
        "created_at": _iso(r[4]),
        "monitor_ids": list(r[5]),
        "kept_7d": r[6],
        "dropped_7d": r[7],
        "last_kept_at": _iso(r[8]),
        "judged_24h": r[9],
        "skipped_24h": r[10],
        "daily_budget": DAILY_BUDGET,
    }


def load_watchers(cur, user_id: str) -> list[dict]:
    cur.execute(
        _WATCHER_SELECT + " WHERE w.user_id = %(user)s GROUP BY w.id ORDER BY w.created_at, w.id",
        {"user": user_id, "days": DECISION_DAYS},
    )
    return [_watcher_row(r) for r in cur.fetchall()]


def load_watcher(cur, user_id: str, watcher_id: int) -> dict | None:
    cur.execute(
        _WATCHER_SELECT + " WHERE w.user_id = %(user)s AND w.id = %(watcher)s GROUP BY w.id",
        {"user": user_id, "watcher": watcher_id, "days": DECISION_DAYS},
    )
    row = cur.fetchone()
    return _watcher_row(row) if row else None


def _set_monitors(cur, user_id: str, watcher_id: int, monitor_ids: list[int]) -> None:
    """Replace the watcher's selection. Only monitors the reader follows are
    kept: a watcher cannot read what its reader does not."""
    cur.execute("DELETE FROM watcher_monitors WHERE watcher_id = %s", (watcher_id,))
    cur.execute(
        """INSERT INTO watcher_monitors (watcher_id, monitor_id)
           SELECT %s, s.monitor_id FROM subscriptions s
            WHERE s.user_id = %s AND s.monitor_id = ANY(%s)""",
        (watcher_id, user_id, monitor_ids),
    )


def create_watcher(cur, user_id: str, name: str, request: str, monitor_ids: list[int]) -> dict:
    cur.execute(
        "INSERT INTO watchers (user_id, name, request) VALUES (%s, %s, %s) RETURNING id",
        (user_id, name.strip(), request.strip()),
    )
    watcher_id = cur.fetchone()[0]
    _set_monitors(cur, user_id, watcher_id, monitor_ids)
    return load_watcher(cur, user_id, watcher_id)


def update_watcher(cur, user_id: str, watcher_id: int, *, name: str | None = None,
                 request: str | None = None, status: str | None = None,
                 monitor_ids: list[int] | None = None) -> dict | None:
    """Change what is given; None leaves a field as it is."""
    cur.execute(
        """UPDATE watchers
              SET name = COALESCE(%s, name),
                  request = COALESCE(%s, request),
                  status = COALESCE(%s, status)
            WHERE id = %s AND user_id = %s
        RETURNING id""",
        (name.strip() if name is not None else None,
         request.strip() if request is not None else None,
         status, watcher_id, user_id),
    )
    if cur.fetchone() is None:
        return None
    if monitor_ids is not None:
        _set_monitors(cur, user_id, watcher_id, monitor_ids)
    return load_watcher(cur, user_id, watcher_id)


def delete_watcher(cur, user_id: str, watcher_id: int) -> None:
    cur.execute("DELETE FROM watchers WHERE id = %s AND user_id = %s", (watcher_id, user_id))


# ── Decisions ───────────────────────────────────────────────────────────────
def _scopes(cur, user_id: str) -> dict[int, set[int]]:
    """The monitors each active watcher of the reader reads, as the judge
    computes them."""
    cur.execute(
        """SELECT w.id,
                  ARRAY(SELECT s.monitor_id FROM subscriptions s
                         WHERE s.user_id = w.user_id
                           AND (NOT EXISTS (SELECT 1 FROM watcher_monitors wm
                                             WHERE wm.watcher_id = w.id)
                                OR EXISTS (SELECT 1 FROM watcher_monitors wm
                                            WHERE wm.watcher_id = w.id
                                              AND wm.monitor_id = s.monitor_id)))
             FROM watchers w
            WHERE w.user_id = %s AND w.status = 'active'""",
        (user_id,),
    )
    return {r[0]: set(r[1]) for r in cur.fetchall()}


def _story_monitors(cur, story_ids: list[int]) -> dict[int, set[int]]:
    cur.execute(
        """SELECT si.story_id, mi.monitor_id
             FROM story_items si
             JOIN monitor_items mi ON mi.item_id = si.item_id
            WHERE si.story_id = ANY(%s)""",
        (story_ids,),
    )
    out: dict[int, set[int]] = defaultdict(set)
    for story_id, monitor_id in cur.fetchall():
        out[story_id].add(monitor_id)
    return out


def load_decisions(cur, user_id: str, lang: str) -> list[dict]:
    """The reader's story moments of the last DECISION_DAYS, newest first."""
    cur.execute(
        """SELECT j.id, j.watcher_id, j.story_id, j.pass_at, j.verdict, j.reason,
                   j.excerpt, j.input, j.model, j.input_tokens, j.output_tokens,
                   j.created_at,
                   COALESCE(NULLIF(s.label_translations ->> %(lang)s, ''), s.label)
              FROM judgments j
              JOIN watchers w ON w.id = j.watcher_id
              JOIN stories s ON s.id = j.story_id
             WHERE w.user_id = %(user)s
               AND j.created_at > now() - make_interval(days => %(days)s)
             ORDER BY j.pass_at DESC, j.story_id, j.id
             LIMIT %(limit)s""",
        {"user": user_id, "lang": lang, "limit": MAX_JUDGMENTS, "days": DECISION_DAYS},
    )
    rows = cur.fetchall()
    if not rows:
        return []
    story_ids = list({r[2] for r in rows})
    return group_moments(rows, _scopes(cur, user_id), _story_monitors(cur, story_ids))


def group_moments(rows: list[tuple], scopes: dict[int, set[int]],
                  story_monitors: dict[int, set[int]]) -> list[dict]:
    """Group judgment rows, newest pass first, into story moments.

    `scopes` holds the monitors of each active watcher, `story_monitors`
    the monitors that delivered each story's articles: together they say
    why a watcher did not judge a moment.
    """
    moments: dict[tuple, dict] = {}
    for (jid, watcher_id, story_id, pass_at, verdict, reason, excerpt, inp,
         model, t_in, t_out, created_at, story_label) in rows:
        key = (story_id, pass_at)
        m = moments.get(key)
        if m is None:
            m = moments[key] = {
                "id": jid,
                "story_id": story_id,
                "label": story_label or inp.get("label") or "",
                "at": _iso(pass_at),
                "articles": [],
                "decisions": [],
                "not_judged": [],
            }
        m["id"] = min(m["id"], jid)
        seen = {a["url"] for a in m["articles"]}
        m["articles"] += [a for a in inp.get("articles", []) if a.get("url") not in seen]
        if verdict == "skipped":
            m["not_judged"].append({"watcher_id": watcher_id, "reason": "budget"})
            continue
        m["decisions"].append({
            "watcher_id": watcher_id,
            "verdict": verdict,
            "reason": reason,
            "excerpt": excerpt,
            "input": {
                "label": inp.get("label", ""),
                "synthesis": inp.get("synthesis", ""),
                "articles": inp.get("articles", []),
                "already_kept": inp.get("already_kept"),
            },
            "model": model,
            "input_tokens": t_in,
            "output_tokens": t_out,
            "decided_at": _iso(created_at),
        })

    # A watcher that judged the story on another pass had nothing new to
    # judge on this one: it is left out rather than listed as waiting.
    judged_ever = {(r[1], r[2]) for r in rows}
    for (story_id, _), m in moments.items():
        judged = {d["watcher_id"] for d in m["decisions"]} | {n["watcher_id"] for n in m["not_judged"]}
        for watcher_id, scope in scopes.items():
            if watcher_id in judged:
                continue
            in_scope = bool(scope & story_monitors.get(story_id, set()))
            if in_scope and (watcher_id, story_id) in judged_ever:
                continue
            m["not_judged"].append({
                "watcher_id": watcher_id,
                "reason": "pending" if in_scope else "out_of_scope",
            })
    return list(moments.values())
