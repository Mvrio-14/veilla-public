"""
The collector: one worker pass over the monitors to fetch.

For every monitor it asks the monitor's template to fetch from where the
last fetch left off, then, the same way whatever the template:

  - stores the items (src/item_store.py);
  - keeps the monitor's health — failures counted, `degraded` then `dead`
    past a threshold, `active` again on the first success;
  - saves the cursor the template returned, and moves the monitor to a new
    config when the template says the source has moved;
  - records the fetch in `monitor_runs`.

Fetches run in parallel threads and touch no database; everything after
runs on one connection, monitor by monitor, in input order.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone

from src.item_store import store_items
from src.templates import FetchError, FetchResult, get_template, prepare

# Thresholds, deliberately permissive — a monitor gets several hours of
# benefit of the doubt before it is degraded:
#   - 30 consecutive failures → degraded (~2.5h at one pass every 5 min)
#   - 60 consecutive failures → dead (~28h in all, most of it spent
#                               degraded and tried one pass in ten)
#   - any success             → active again at once
DEGRADE_THRESHOLD = 30
DEATH_THRESHOLD   = 60

# Parallel fetches. Each is an HTTP request and a parse — cheap threads —
# and a pass of a hundred-odd monitors finishes in about a minute.
FETCH_WORKERS = 30


@dataclass
class _Fetch:
    monitor:     dict
    started_at:  datetime
    duration_ms: int
    result:      FetchResult | None = None
    error:       str | None = None


def collect_and_store(monitors: list[dict], conn) -> dict:
    """Fetch every monitor and store what they bring.

    Returns {"inserted": n, "ok": [names], "failed": [names]}.
    """
    cursor = conn.cursor()
    # Asked per monitor through EXISTS, one index probe each: a DISTINCT
    # over the deliveries reads all of them, which cost hours of CPU a day.
    cursor.execute(
        """SELECT m.id FROM monitors m
            WHERE m.id = ANY(%s)
              AND EXISTS (SELECT 1 FROM monitor_items mi WHERE mi.monitor_id = m.id)""",
        ([m["id"] for m in monitors],),
    )
    has_delivered = {row[0] for row in cursor.fetchall()}

    fetches = _fetch_all(monitors)

    print("\n--- Processing monitors ---")
    total, ok, failed = 0, [], []
    for f in fetches:
        monitor = f.monitor
        if f.error is not None:
            print(f"[FAILED] {monitor['name']} - {f.error}")
            failed.append(monitor["name"])
            _record_failure(cursor, monitor, f.error)
            _record_run(cursor, f, "failed", error=f.error)
            continue

        result = f.result
        for warning in result.warnings:
            print(f"  [WARN] {monitor['name']} — {warning}")
        _record_success(cursor, monitor, result.cursor)
        if result.new_config is not None:
            _move(cursor, monitor, result.new_config)

        if result.not_modified:
            print(f"[304]  {monitor['name']} - not modified")
            ok.append(monitor["name"])
            _record_run(cursor, f, "not_modified")
            continue

        n_new = store_items(
            cursor, monitor, result.items, f.started_at.isoformat(),
            first_delivery=monitor["id"] not in has_delivered,
        )
        print(f"OK: {monitor['name']} - {n_new} new of {len(result.items)}")
        ok.append(monitor["name"])
        total += n_new
        _record_run(cursor, f, "ok", items_seen=len(result.items), items_new=n_new)

    conn.commit()
    print(f"\nTotal: {total} new items inserted")
    if failed:
        print(f"\n[ALERT] {len(failed)} monitor(s) could not be fetched: {', '.join(failed)}")
    return {"inserted": total, "ok": ok, "failed": failed}


# ── Fetching ────────────────────────────────────────────────────────────────
def _fetch_all(monitors: list[dict]) -> list[_Fetch]:
    """Fetch every monitor in parallel. Results come back in input order."""
    print(f"Fetching {len(monitors)} monitor(s) with {FETCH_WORKERS} parallel workers...")
    t0 = time.monotonic()
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        fetches = list(pool.map(_fetch_one, monitors))
    print(f"  Done in {time.monotonic() - t0:.1f}s")
    return fetches


def _fetch_one(monitor: dict) -> _Fetch:
    started_at = datetime.now(timezone.utc)
    t0 = time.monotonic()
    try:
        result = get_template(monitor["template"]).fetch(monitor["config"], monitor["cursor"])
        error = None
    except FetchError as e:
        result, error = None, str(e)
    except Exception as e:
        # A template bug must cost one monitor, not the pass.
        result, error = None, f"{type(e).__name__}: {e}"
    return _Fetch(monitor, started_at, int((time.monotonic() - t0) * 1000), result, error)


# ── Bookkeeping ─────────────────────────────────────────────────────────────
def _record_run(cursor, f: _Fetch, outcome: str, *,
                items_seen: int = 0, items_new: int = 0, error: str | None = None) -> None:
    cursor.execute(
        """INSERT INTO monitor_runs
               (monitor_id, started_at, duration_ms, outcome, items_seen, items_new, error)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (f.monitor["id"], f.started_at, f.duration_ms, outcome, items_seen, items_new, error),
    )


def _record_success(cursor, monitor: dict, new_cursor: dict) -> None:
    """Reset the failure count, bring the monitor back to active and keep
    the template's cursor. A recovery from degraded is logged, not
    reported: the degradation issue stays open in Sentry until closed."""
    cursor.execute(
        """UPDATE monitors
              SET consecutive_failures = 0,
                  last_success_at      = now(),
                  status               = 'active',
                  cursor               = %s::jsonb
            WHERE id = %s""",
        (json.dumps(new_cursor), monitor["id"]),
    )
    if monitor["status"] == "degraded":
        print(f"  [monitor-recovery] {monitor['name']} back to active")


def _record_failure(cursor, monitor: dict, reason: str) -> None:
    """Count the failure, move the monitor down when it crosses a
    threshold, and report the transition — once — to Sentry."""
    old_status = monitor["status"]
    count = monitor["consecutive_failures"] + 1
    if count >= DEATH_THRESHOLD:
        new_status = "dead"
    elif count >= DEGRADE_THRESHOLD:
        new_status = "degraded"
    else:
        new_status = old_status

    cursor.execute(
        """UPDATE monitors
              SET consecutive_failures = %s,
                  last_failure_at      = now(),
                  status               = %s
            WHERE id = %s""",
        (count, new_status, monitor["id"]),
    )
    if new_status != old_status:
        # Imported here to keep Sentry out of the hot path when it is off.
        from src.observability import capture_feed_death, capture_feed_degradation
        if new_status == "degraded":
            capture_feed_degradation(monitor["name"], count, reason)
        else:
            capture_feed_death(monitor["name"], count, reason)


def _move(cursor, monitor: dict, new_config: dict) -> None:
    """Move a monitor — and the catalogue entry it fetches — to the config
    its template says the source now lives at.

    When another monitor or catalogue entry already has that config, the
    two cannot be merged here: the move is skipped and reported for
    someone to reconcile. The template will ask again on later fetches.
    """
    _, config, identity_key = prepare(monitor["template"], new_config)
    old_url = monitor["config"].get("url")
    new_url = config.get("url")

    cursor.execute(
        """SELECT 'monitor', id FROM monitors
            WHERE identity_key = %s AND visibility = 'public' AND id <> %s
           UNION ALL
           SELECT 'catalog entry', id FROM catalog
            WHERE identity_key = %s AND id IS DISTINCT FROM %s
           LIMIT 1""",
        (identity_key, monitor["id"], identity_key, monitor["catalog_id"]),
    )
    conflict = cursor.fetchone()
    if conflict is not None:
        from src.observability import capture_feed_redirect_conflict
        capture_feed_redirect_conflict(monitor["name"], old_url, new_url, int(conflict[1]))
        print(f"  [monitor-move-conflict] {monitor['name']}: cannot move to "
              f"{new_url} — already used by {conflict[0]} id={conflict[1]}")
        return

    cursor.execute(
        "UPDATE monitors SET config = %s::jsonb, identity_key = %s WHERE id = %s",
        (json.dumps(config), identity_key, monitor["id"]),
    )
    if monitor["catalog_id"] is not None:
        cursor.execute(
            "UPDATE catalog SET config = %s::jsonb, identity_key = %s WHERE id = %s",
            (json.dumps(config), identity_key, monitor["catalog_id"]),
        )
    from src.observability import capture_feed_url_migrated
    capture_feed_url_migrated(monitor["name"], old_url, new_url)
    print(f"  [monitor-moved] {monitor['name']}: {old_url} -> {new_url}")
