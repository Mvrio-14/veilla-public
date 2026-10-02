"""
Diagnostic: EXPLAIN (ANALYZE, BUFFERS) on load_visible_articles for a
given user, using their real feeds and language.

The script does NOT duplicate the SQL — it monkey-patches `conn.cursor`
so the first multi-CTE query emitted by `loaders.watch.load_visible_articles`
is captured (without executing), then we re-issue it prefixed with
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT). That way the diagnostic
stays in sync with whatever the prod code actually runs.

Usage:
    python -m scripts.explain_load_visible_articles <user-slug>
    python -m scripts.explain_load_visible_articles <user-slug> --window-hours 24
"""
import argparse
import os
import sys
import time
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.extensions import cursor as _PgCursor

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


# Sentinel raised inside the patched cursor.execute() to bail out of
# `load_visible_articles` after we've captured the SQL+params.
class _QueryCaptured(Exception):
    def __init__(self, sql, params):
        super().__init__("captured first multi-CTE query")
        self.sql = sql
        self.params = params


def _fetch_user_context(conn, slug: str):
    """Pull the same inputs load_watch receives at runtime: user_id,
    output_lang and the monitors the user subscribes to."""
    from src.monitors import get_user_monitor_ids

    cur = conn.cursor()

    cur.execute("SELECT id, output_lang FROM users WHERE slug = %s", (slug,))
    row = cur.fetchone()
    if not row:
        sys.exit(f"User not found: {slug}")
    user_id, output_lang = row

    cur.close()
    return {
        "user_id":     str(user_id),
        "output_lang": output_lang or "en",
        "monitor_ids": get_user_monitor_ids(conn, user_id),
    }


class _InterceptingCursor(_PgCursor):
    """Subclass of psycopg2's default cursor. The first execute() whose
    SQL looks like the Watch's multi-CTE query (matched by the
    presence of `active_story_ids AS MATERIALIZED` — a CTE that's been
    stable across the recent refactors) raises `_QueryCaptured` with
    the SQL+params, BEFORE actually hitting Postgres. Any other
    execute() falls through to the real psycopg2 implementation.

    The marker is intentionally something downstream of the first CTE
    so it survives reshaping the early CTEs (e.g. splitting
    recent_in_scope into recent_articles + recent_in_scope)."""

    def execute(self, sql, params=None):
        sql_str = sql if isinstance(sql, str) else sql.decode("utf-8", errors="replace")
        if "active_story_ids AS MATERIALIZED" in sql_str:
            raise _QueryCaptured(sql, params)
        return super().execute(sql, params)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("slug", help="user slug")
    parser.add_argument(
        "--window-hours", type=int, default=24,
        help="time window passed to load_watch (default: 24, matches the SPA default)",
    )
    parser.add_argument(
        "--out", type=str, default=None,
        help="optional path to write the EXPLAIN plan to (otherwise stdout only)",
    )
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL_DIRECT") or os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL_DIRECT / DATABASE_URL not set in .env")

    print(f"Connecting to {dsn.split('@')[-1].split('?')[0]}")
    conn = psycopg2.connect(dsn, connect_timeout=15)
    conn.autocommit = False

    setup = conn.cursor()
    setup.execute("SET statement_timeout = 0")
    setup.close()
    conn.commit()

    ctx = _fetch_user_context(conn, args.slug)
    print(f"User:        {args.slug} (lang={ctx['output_lang']})")
    print(f"Monitors:    {len(ctx['monitor_ids'])}")
    print(f"Window:      {args.window_hours}h")
    print()

    # ── Swap the connection's default cursor_factory to our intercepting
    # subclass, then call load_visible_articles. The first execute()
    # matching the Watch query raises and we capture its inputs.
    # We restore the original factory in `finally` so subsequent cursors
    # (for the EXPLAIN, conn.close, etc.) behave normally.
    from src.loaders.watch import load_visible_articles
    from src.watch_query import QueryState

    original_factory = conn.cursor_factory
    conn.cursor_factory = _InterceptingCursor

    qs = QueryState(period_hours=args.window_hours)
    captured_sql = None
    captured_params = None
    try:
        load_visible_articles(
            conn,
            monitor_ids=ctx["monitor_ids"],
            window_hours=args.window_hours,
            output_lang=ctx["output_lang"],
            query_state=qs,
        )
    except _QueryCaptured as e:
        captured_sql = e.sql
        captured_params = e.params
    finally:
        conn.cursor_factory = original_factory

    if not captured_sql:
        sys.exit(
            "Failed to capture the Watch query — the code path may "
            "have moved away from `WITH recent_in_scope`. Adjust the marker "
            "in `_InterceptingCursor.execute` accordingly."
        )

    # The patched cursor raised mid-execute → the implicit tx is aborted.
    # Roll it back before issuing the EXPLAIN.
    conn.rollback()

    # ── EXPLAIN the captured query ─────────────────────────────────────
    explain_sql = (
        "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)\n" + captured_sql
    )
    print(
        f"Running EXPLAIN ANALYZE on captured query "
        f"({len(captured_sql):,} chars, {len(captured_params)} params)…"
    )
    t0 = time.time()
    cur = conn.cursor()
    cur.execute("SET statement_timeout = 0")
    cur.execute(explain_sql, captured_params)
    rows = cur.fetchall()
    elapsed = time.time() - t0
    cur.close()
    conn.close()

    plan_text = "\n".join(r[0] for r in rows)
    header = (
        f"\n──────── EXPLAIN plan ({elapsed:.1f}s real) ────────\n"
        f"user={args.slug}  window={args.window_hours}h  "
        f"monitors={len(ctx['monitor_ids'])}  "
        f"lang={ctx['output_lang']}\n"
    )
    print(header)
    print(plan_text)

    if args.out:
        out_path = Path(args.out)
        out_path.write_text(header + "\n" + plan_text, encoding="utf-8")
        print(f"\nPlan also written to {out_path}")


if __name__ == "__main__":
    main()
