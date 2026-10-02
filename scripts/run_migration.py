"""
Generic runner for heavy SQL migrations that exceed Supabase SQL Editor's
58s HTTP timeout (e.g. ADD COLUMN GENERATED STORED, ALTER COLUMN TYPE on
big tables, CREATE INDEX CONCURRENTLY, GIN index builds).

Connects directly to `DATABASE_URL_DIRECT` (no pooler / no dashboard
middleware) and disables `statement_timeout` for the session. The script
auto-detects the migration's `-- STEP N` markers and runs each step as a
separate statement, polling `pg_stat_activity` in a background thread so
you see live state (wait_event, elapsed time, blocking PIDs).

Usage:
    python -m scripts.run_migration 0005_signal

The argument is the migration file name (without `.sql` extension) under
`migrations/`. The script will refuse to run if the file doesn't exist.

Pre-flight checklist:
  1. Suspend `veilla-api` and `veilla-worker` on Render (any ALTER TABLE
     or CREATE INDEX needs an AccessExclusiveLock; an active worker will
     queue the migration behind every running query forever).
  2. Run this script.
  3. Watch the monitor output. CONCURRENTLY indexes can be backgrounded —
     don't kill the script unless wait_event_type is Lock and a blocking
     PID is identified.
  4. Resume the services after the script reports "All steps completed".
"""
import os
import re
import sys
import threading
import time
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "migrations"

load_dotenv(ROOT / ".env")


def _monitor_loop(dsn: str, pid: int, stop_event: threading.Event,
                  step_label: str, poll_every: float = 3.0) -> None:
    """Background thread that polls `pg_stat_activity` on the executing
    backend PID. Surfaces wait_event, elapsed time, and blocking PIDs so
    we can distinguish "slow but progressing" from "blocked on a lock".
    """
    try:
        mon_conn = psycopg2.connect(dsn, connect_timeout=15)
    except Exception as e:
        print(f"  [monitor] failed to open monitor conn: {e}", flush=True)
        return
    mon_conn.autocommit = True
    mon_cur = mon_conn.cursor()

    poll_count = 0
    while not stop_event.is_set():
        poll_count += 1
        try:
            mon_cur.execute("""
                SELECT state, wait_event_type, wait_event,
                       extract(epoch FROM now() - query_start) AS elapsed,
                       extract(epoch FROM now() - xact_start) AS xact_age,
                       substring(query, 1, 80) AS q
                FROM pg_stat_activity
                WHERE pid = %s
            """, (pid,))
            row = mon_cur.fetchone()
            if row is None:
                print(f"  [monitor #{poll_count}] backend pid {pid} GONE — "
                      f"step finished server-side", flush=True)
                break
            state, wet, we, elapsed, xact_age, q = row
            wait_str = f"{wet}:{we}" if wet else "—"
            elapsed_str = f"{elapsed:.0f}s" if elapsed else "n/a"
            xact_str = f"{xact_age:.0f}s" if xact_age else "n/a"
            print(f"  [monitor #{poll_count}] state={state!r:<10} "
                  f"wait={wait_str:<24} elapsed={elapsed_str:<6} "
                  f"xact={xact_str:<6} q={q!r}", flush=True)

            if poll_count % 20 == 0:
                mon_cur.execute("SELECT pg_blocking_pids(%s)", (pid,))
                blockers = mon_cur.fetchone()[0]
                if blockers:
                    print(f"  [monitor] blocked by PIDs: {blockers}", flush=True)
        except Exception as e:
            print(f"  [monitor] poll error: {e}", flush=True)
        stop_event.wait(poll_every)

    try:
        mon_conn.close()
    except Exception:
        pass


_STEP_HEADER_RE = re.compile(r"-- STEP (\d+)([^\n]*)\n")


def _read_steps(migration_path: Path) -> list[tuple[str, str]]:
    """Slice the migration file into its logical steps based on
    `-- STEP N` markers. If no markers, treat the whole file as one step."""
    raw = migration_path.read_text(encoding="utf-8")
    headers = list(_STEP_HEADER_RE.finditer(raw))
    if not headers:
        # No markers — return the whole file as one step.
        return [("STEP 1", raw)]
    steps: list[tuple[str, str]] = []
    for idx, m in enumerate(headers):
        body_start = m.end()
        body_end = headers[idx + 1].start() if idx + 1 < len(headers) else len(raw)
        body = raw[body_start:body_end]
        label = f"STEP {m.group(1)}{m.group(2)}".strip()
        steps.append((label, body))
    return steps


def _strip_step_block_comments(sql: str) -> str:
    """Drop the leading '-- ...' comment block under each STEP header
    so we don't accidentally execute an empty/comment-only slice."""
    lines = sql.splitlines()
    out = []
    in_leading_comments = True
    for line in lines:
        if in_leading_comments and (line.strip().startswith("--") or not line.strip()):
            continue
        in_leading_comments = False
        out.append(line)
    return "\n".join(out).strip()


def _execute_step(cur, sql: str) -> None:
    """Execute a step's SQL respecting CREATE INDEX CONCURRENTLY's
    requirement that it run OUTSIDE a transaction block.

    Strategy:
      - If the step explicitly opens a transaction (BEGIN; ... COMMIT;)
        we execute as a single statement so the transaction holds.
      - Otherwise we split on `;` and execute each statement on its own
        round-trip. psycopg2 in autocommit mode treats each `cur.execute`
        as its own implicit-or-explicit transaction, so CONCURRENTLY
        statements work; bundling them in one execute() would wrap them
        in psycopg2's implicit batch transaction and Postgres would
        reject the CONCURRENTLY (the symptom seen on 0058 STEP 2).
    """
    sql_lower = sql.lower()
    has_explicit_tx = "begin;" in sql_lower or "begin\n" in sql_lower
    if has_explicit_tx:
        cur.execute(sql)
        return
    # Strip line comments so they don't end up in mid-statement splits.
    cleaned_lines = []
    for line in sql.splitlines():
        s = line.strip()
        if s.startswith("--"):
            continue
        cleaned_lines.append(line)
    cleaned = "\n".join(cleaned_lines)
    # Split on semicolons. Naive but fine — our migrations don't embed
    # ';' inside string literals at top level.
    statements = [s.strip() for s in cleaned.split(";") if s.strip()]
    for i, stmt in enumerate(statements, start=1):
        print(f"    [sub-statement {i}/{len(statements)}] {stmt[:80]}...", flush=True)
        cur.execute(stmt)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(
            "Usage: python -m scripts.run_migration <migration_name> [--from-step=N]\n"
            "Example: python -m scripts.run_migration 0005_signal\n"
            "         python -m scripts.run_migration 0005_signal --from-step=2\n"
            "\n"
            "--from-step=N  Skip steps 1..N-1 and start at STEP N. Useful to\n"
            "                resume a migration after partial success without\n"
            "                redoing expensive rewrites."
        )

    name = sys.argv[1].removesuffix(".sql")
    migration_path = MIGRATIONS_DIR / f"{name}.sql"
    if not migration_path.exists():
        sys.exit(f"Migration not found: {migration_path}")

    from_step = 1
    for arg in sys.argv[2:]:
        if arg.startswith("--from-step="):
            try:
                from_step = int(arg.split("=", 1)[1])
            except ValueError:
                sys.exit(f"Invalid --from-step value: {arg}")

    dsn = os.environ.get("DATABASE_URL_DIRECT") or os.environ.get("DATABASE_URL")
    if not dsn:
        sys.exit("DATABASE_URL_DIRECT / DATABASE_URL not set in .env")

    steps = _read_steps(migration_path)
    if not steps:
        sys.exit(f"No content in {migration_path}")

    print(f"Migration: {name}")
    print(f"Connecting to {dsn.split('@')[-1].split('?')[0]}")
    conn = psycopg2.connect(dsn, connect_timeout=15)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("SET statement_timeout = 0")
    cur.execute("SELECT pg_backend_pid()")
    backend_pid = cur.fetchone()[0]
    print(f"Postgres backend pid: {backend_pid}")
    print("(monitor polls pg_stat_activity every 3s during each step)")

    for i, (label, sql) in enumerate(steps, start=1):
        if i < from_step:
            print(f"[{i}/{len(steps)}] {label}: SKIPPED (--from-step={from_step})")
            continue
        sql = _strip_step_block_comments(sql)
        if not sql:
            print(f"[{i}/{len(steps)}] {label}: empty, skipped")
            continue
        print(f"\n[{i}/{len(steps)}] {label}")
        print(f"  → executing ({len(sql)} chars)...")

        stop_event = threading.Event()
        monitor = threading.Thread(
            target=_monitor_loop,
            args=(dsn, backend_pid, stop_event, label),
            daemon=True,
        )
        monitor.start()

        t0 = time.time()
        try:
            _execute_step(cur, sql)
        except psycopg2.Error as e:
            elapsed = time.time() - t0
            stop_event.set()
            monitor.join(timeout=5)
            print(f"  ✗ FAILED after {elapsed:.1f}s: {e}")
            sys.exit(1)
        finally:
            stop_event.set()
            monitor.join(timeout=5)

        elapsed = time.time() - t0
        print(f"  ✓ done in {elapsed:.1f}s")

    cur.close()
    conn.close()
    print("\nAll steps completed.")


if __name__ == "__main__":
    main()
