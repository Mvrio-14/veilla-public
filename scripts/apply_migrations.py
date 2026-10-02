"""
Apply the versioned SQL migrations in `migrations/` to a database.

Day to day, migrations are applied by hand through the Supabase SQL
editor, one at a time, as they are written. Bootstrapping a *blank*
database is the other case: every file has to be replayed in order. That
is what this script is for.

It is idempotent and safe to run at any time: already-applied files are
skipped, so it doubles as a way to bring a lagging environment up to date.

## Guarantees

- **Order.** Files are sorted lexicographically, which is the convention
  the `migrations/` directory relies on.
- **Resumability.** Every applied file is recorded in
  `schema_migrations`. Re-running only replays what is missing — which
  matters on a long bootstrap run, where something will fail and you do
  not want to start over.
- **One transaction per file**, except where the SQL itself makes that
  impossible (see below).

## Hazard 1 — concurrent index builds

Postgres forbids `CREATE INDEX CONCURRENTLY` inside a transaction, and
rightly so: the point of that form is to avoid locking the table while
the index is built, which a surrounding transaction would undo.

The trap is subtler than it looks. Sending a whole file as one message —
what `cur.execute(entire_file)` does — is enough to trigger the
restriction: **a multi-statement query string is an implicit transaction
block**, even on an autocommit connection, and even when the file has its
own `COMMIT;` halfway through. A `BEGIN` / `COMMIT` written in the SQL
cannot help.

The only way out is to send the statements **one at a time**. The file's
own `BEGIN` / `COMMIT` then does its job: the part meant to be atomic is,
and the concurrent builds run after the `COMMIT`, outside any
transaction — which is how such a file is meant to be laid out.

Hence `split_statements()` below; a naive `split(";")` would cut through
`$$ ... $$` function bodies.

The cost of that mode is real and is reported honestly on failure: a file
executed statement by statement can be left **partially applied** if it
fails after one of its own `COMMIT`s.

## Hazard 2 — scheduled jobs replaced but never created

A migration that edits a recurring job typically unschedules it before
scheduling the new body. That pattern assumes the job already exists —
true in the environment where it was written, false on a blank database,
where the `cron.unschedule()` call fails and takes the migration with it.

Rather than special-casing job names, this script scans the migrations
for every `cron.unschedule('<name>')` and pre-creates any of those jobs
that do not exist yet, as a no-op. The migrations then replace them with
their real bodies, as intended.

## Usage

    python scripts/apply_migrations.py

Requires `DATABASE_URL` in `.env`. If any migration schedules cron jobs,
the `pg_cron` extension must be enabled first (on Supabase: Dashboard >
Database > Extensions).
"""
from __future__ import annotations

import os
import pathlib
import re
import sys

import psycopg2
from dotenv import load_dotenv

ROOT = pathlib.Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = ROOT / "migrations"

_DOLLAR_TAG = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$")
_UNSCHEDULE = re.compile(r"cron\.unschedule\(\s*'([^']+)'", re.I)

# Placeholder schedule for pre-created jobs. Never runs anything
# meaningful — the migration that follows overwrites the body.
_PLACEHOLDER_CRON = "0 3 * * *"
_PLACEHOLDER_BODY = "SELECT 1"


def split_statements(sql: str) -> list[str]:
    """Split a SQL script into statements without falling into the traps.

    A plain `sql.split(";")` would break on three things that genuinely
    occur in migrations: function bodies delimited by `$$`, semicolons
    inside string literals, and semicolons inside comments. So the text is
    scanned while tracking which of those it is in.
    """
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)

    while i < n:
        if sql.startswith("--", i):                     # line comment
            j = sql.find("\n", i)
            j = n if j == -1 else j
            buf.append(sql[i:j]); i = j; continue

        if sql.startswith("/*", i):                     # block comment
            j = sql.find("*/", i + 2)
            j = n if j == -1 else j + 2
            buf.append(sql[i:j]); i = j; continue

        if sql[i] == "'":                               # string literal
            j = i + 1
            while j < n:
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":  # escaped ''
                        j += 2; continue
                    j += 1; break
                j += 1
            buf.append(sql[i:j]); i = j; continue

        if sql[i] == "$":                               # $$ body $$
            m = _DOLLAR_TAG.match(sql, i)
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                j = n if j == -1 else j + len(tag)
                buf.append(sql[i:j]); i = j; continue

        if sql[i] == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []; i += 1; continue

        buf.append(sql[i]); i += 1

    tail = "".join(buf).strip()
    if tail:
        out.append(tail)

    # A "statement" that is nothing but a comment has nothing to send.
    return [s for s in out if not _is_only_comment(s)]


def _is_only_comment(stmt: str) -> bool:
    stripped = re.sub(r"/\*.*?\*/", "", stmt, flags=re.S)
    stripped = re.sub(r"^\s*--.*$", "", stripped, flags=re.M)
    return not stripped.strip()


def ensure_tracking(conn) -> None:
    """Create the table that makes this script resumable.

    Deliberately minimal — a filename and a timestamp. Its only job is to
    answer "has this one already run?".
    """
    with conn, conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                filename   text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
        """)


def jobs_expected_to_exist(files: list[pathlib.Path]) -> set[str]:
    """Job names the migrations unschedule, and therefore assume exist."""
    names: set[str] = set()
    for path in files:
        names.update(_UNSCHEDULE.findall(path.read_text(encoding="utf-8")))
    return names


def ensure_cron_jobs(conn, names: set[str]) -> tuple[int, bool]:
    """Pre-create missing jobs. Returns (created, pg_cron_available)."""
    if not names:
        return 0, True
    created = 0
    try:
        with conn, conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'")
            if cur.fetchone() is None:
                return 0, False
            for name in sorted(names):
                cur.execute("SELECT 1 FROM cron.job WHERE jobname = %s", (name,))
                if cur.fetchone() is None:
                    cur.execute(
                        "SELECT cron.schedule(%s, %s, %s)",
                        (name, _PLACEHOLDER_CRON, _PLACEHOLDER_BODY),
                    )
                    created += 1
        return created, True
    except psycopg2.Error:
        conn.rollback()
        return created, False


def apply_file(conn, path: pathlib.Path) -> bool:
    """Apply one migration. Returns True if it ran atomically.

    Raises psycopg2.Error on failure. A False return means the file was
    executed statement by statement, so a failure may have left it
    partially applied.
    """
    sql = path.read_text(encoding="utf-8")

    if "CONCURRENTLY" in sql.upper():
        # See "Hazard 1": one statement at a time, or Postgres refuses.
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                for stmt in split_statements(sql):
                    cur.execute(stmt)
                cur.execute(
                    "INSERT INTO schema_migrations (filename) VALUES (%s)",
                    (path.name,),
                )
        except psycopg2.Error:
            # The file may have opened its own transaction before failing.
            conn.rollback()
            raise
        finally:
            conn.autocommit = False
        return False

    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute(
                "INSERT INTO schema_migrations (filename) VALUES (%s)",
                (path.name,),
            )
        conn.commit()
    except psycopg2.Error:
        conn.rollback()
        raise
    return True


def main() -> int:
    load_dotenv(ROOT / ".env")
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set in .env — nothing to do.")
        return 1

    files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        print(f"No .sql files in {MIGRATIONS_DIR}.")
        return 1

    conn = psycopg2.connect(url)
    ensure_tracking(conn)

    expected_jobs = jobs_expected_to_exist(files)
    created, cron_ok = ensure_cron_jobs(conn, expected_jobs)
    if expected_jobs and not cron_ok:
        print("pg_cron is not enabled, but these migrations expect existing jobs:")
        for name in sorted(expected_jobs):
            print(f"  {name}")
        print("Enable the extension, then re-run.\n")
    elif created:
        print(f"cron jobs    : {created} placeholder(s) pre-created")

    with conn.cursor() as cur:
        cur.execute("SELECT filename FROM schema_migrations")
        done = {row[0] for row in cur.fetchall()}
    conn.commit()

    todo = [f for f in files if f.name not in done]
    print(f"migrations   : {len(files)} total, "
          f"{len(done)} already applied, {len(todo)} to run\n")

    for path in todo:
        atomic = True
        try:
            atomic = apply_file(conn, path)
            print(f"  ok      {path.name}")
        except psycopg2.Error as exc:
            print(f"\n  FAILED  {path.name}")
            print(f"  {type(exc).__name__}: {str(exc).strip()}")
            if atomic:
                print("\nThe file was rolled back in full. Fix the cause and")
                print("re-run; files that already succeeded are not replayed.")
            else:
                print("\nThis file runs statement by statement, so anything")
                print("before its own COMMIT is already applied. Inspect the")
                print("database before re-running — replaying it whole will")
                print("likely fail on work that is already done.")
            return 1

    print(f"\n{len(todo)} migration(s) applied.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
