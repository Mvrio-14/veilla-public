"""
Database connection (Postgres / Supabase).

# Two connection modes

The two Render services point at Supabase via two different URLs:

  - **API service** (`veilla-api`) → Supabase **transaction pooler**
    (port 6543). pgBouncer multiplexes many short transactions across a
    small pool of real Postgres connections. The API handles bursts of
    250+ concurrent users on /watch + /me/* requests, well above the 60
    direct-conn cap on Supabase Pro. Transaction mode is invisible to
    the application code as long as it sticks to short transactions
    (INSERT / UPDATE / SELECT — no LISTEN/NOTIFY, no session-level
    advisory locks, no explicit prepared statements).

  - **Worker service** (`veilla-worker`) → Supabase **direct** (port
    5432). Needs session-level semantics: `pg_try_advisory_lock` to
    serialise concurrent passes during deploy overlap. Transaction-mode
    poolers can route the next transaction to a different real
    connection, breaking the lock guarantee silently. The worker is one
    long-running process with ~5 concurrent borrows max, so it fits
    well within the 60-conn cap without needing the pooler.

# Code surface

Two getters expose the distinction explicitly:

  - `get_connection()` — borrows from the pool backed by `DATABASE_URL`.
    Used everywhere by default (API endpoints, one-shot scripts, every
    pipeline step except the one holding the worker advisory lock).
  - `get_direct_connection()` — borrows from a pool backed by
    `DATABASE_URL_DIRECT` if set, else falls back to `DATABASE_URL`.
    Used by `runner.run_one_pass()` for the advisory-lock-holding conn.

On the worker service `DATABASE_URL` already points at the direct URL,
so `get_direct_connection()` and `get_connection()` return equivalent
conns — `DATABASE_URL_DIRECT` is an optional override for setups where
both env vars need to coexist on the same service.

Connections are served from a process-wide ThreadedConnectionPool. A
direct `psycopg2.connect()` takes ~1.5s for the TCP + TLS handshake;
with the pool, that cost is paid once at warm-up and subsequent borrows
return in well under a millisecond.

Drop-in semantics: both getters return a regular psycopg2 connection
wrapper. Calling `.close()` returns it to the pool instead of
physically closing — so existing call-sites (`try/finally` with
`conn.close()`) work unchanged.

The schema lives in migrations/*.sql files and is applied via the
Supabase SQL Editor.
"""
import os
from pathlib import Path

import psycopg2
from dotenv import load_dotenv
from psycopg2.pool import ThreadedConnectionPool

ROOT = Path(__file__).resolve().parent.parent

# Load DATABASE_URL from .env if present (no-op if already in env)
load_dotenv(ROOT / ".env")


# ── Connection pools ───────────────────────────────────────────────────────
# Lazy-initialized at first borrow. The default pool is backed by
# DATABASE_URL; the direct pool is backed by DATABASE_URL_DIRECT when set
# (falls back to DATABASE_URL). On the worker service both point at the
# same URL so the second pool is functionally equivalent — its existence
# is for explicitness, not for distinct connection routing.
#
#   - minconn=1  : keep one warm connection so the first request is fast.
#   - maxconn=60 : sized for processing bursts (30 raised PoolErrors on
#                  /me). The
#                  worker uses ~8 parallel conns for resolve_entities
#                  + 8 for refresh_entities, easily reaching 16+
#                  concurrent borrows on top of API serving. Supabase Pro caps direct
#                  connections at ~60, so 60 here (× 2 pools = 120
#                  theoretical) is fine because the two pools rarely
#                  saturate at the same time (direct pool only holds the
#                  pass advisory lock).
_POOL:        ThreadedConnectionPool | None = None
_DIRECT_POOL: ThreadedConnectionPool | None = None

# Optional per-session statement_timeout override. Set this env var on
# the `veilla-worker` Render service to lift Supabase's default ~120s
# timeout for the worker pipeline — `collect` legitimately scans 100+
# RSS feeds in one call, the translation steps cover every reader
# language, etc.; these can each take 2-5 min and a 120s cap
# turns every pass into a cascade of `QueryCanceled` + downstream
# `InFailedSqlTransaction`. Leave
# unset (or empty) on the API service so endpoints keep the default
# safety cap.
#
# Value is the Postgres `statement_timeout` literal — accept anything
# Postgres accepts:
#   - "0"        : disable (no upper bound; for long-running batches)
#   - "900s"     : 15 minutes (recommended for the worker — covers the
#                  longest legit step without letting a runaway query
#                  bake forever)
#   - "30s"      : explicit short cap (e.g. for read-only services)
_DB_STATEMENT_TIMEOUT = os.environ.get("DB_STATEMENT_TIMEOUT", "").strip()


def _build_pool(dsn: str) -> ThreadedConnectionPool:
    return ThreadedConnectionPool(
        minconn=1,
        maxconn=60,
        dsn=dsn,
        connect_timeout=15,
        keepalives=1,
        keepalives_idle=30,      # send keepalive after 30s of idle
        keepalives_interval=10,  # then every 10s
        keepalives_count=5,      # 5 missed before declaring connection dead
    )


def _ensure_pool() -> ThreadedConnectionPool:
    global _POOL
    if _POOL is not None:
        return _POOL
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL not set. Add it to .env (local) or as a CI secret."
        )
    _POOL = _build_pool(dsn)
    return _POOL


def _ensure_direct_pool() -> ThreadedConnectionPool:
    """Pool dedicated to session-level operations (advisory locks). Backed
    by `DATABASE_URL_DIRECT` if set, else `DATABASE_URL`. Always returns a
    direct (non-pooler) Postgres connection in correctly-configured deploys."""
    global _DIRECT_POOL
    if _DIRECT_POOL is not None:
        return _DIRECT_POOL
    dsn = (
        os.environ.get("DATABASE_URL_DIRECT")
        or os.environ.get("DATABASE_URL")
    )
    if not dsn:
        raise RuntimeError(
            "Neither DATABASE_URL_DIRECT nor DATABASE_URL is set."
        )
    _DIRECT_POOL = _build_pool(dsn)
    return _DIRECT_POOL


class _PooledConnection:
    """Lightweight wrapper around a psycopg2 connection that intercepts
    `.close()` to return the underlying connection to the pool instead
    of physically closing it. Every other attribute / method (cursor,
    commit, rollback, context-manager dunders) delegates to the wrapped
    connection via __getattr__.

    psycopg2's connection class is a C-extension type whose methods
    can't be monkey-patched, hence this wrapper instead of a simple
    method swap.
    """

    __slots__ = ("_conn", "_pool", "_returned")

    def __init__(self, conn, pool: ThreadedConnectionPool) -> None:
        # Bypass __setattr__ if we ever add one — using object.__setattr__
        # is safe with __slots__.
        object.__setattr__(self, "_conn", conn)
        object.__setattr__(self, "_pool", pool)
        object.__setattr__(self, "_returned", False)

    def close(self) -> None:
        """Return the underlying connection to the pool. Idempotent —
        callers that close twice (e.g. nested try/finally) get a no-op
        the second time."""
        if self._returned:
            return
        object.__setattr__(self, "_returned", True)
        try:
            if self._conn.closed:
                # Broken connection — drop from pool so the next borrow
                # gets a fresh one.
                self._pool.putconn(self._conn, close=True)
                return
            # Best-effort rollback to discard any uncommitted state from
            # the previous user before handing the conn to the next.
            try:
                self._conn.rollback()
            except Exception:
                pass
            self._pool.putconn(self._conn)
        except Exception:
            # Last-resort physical close if returning to the pool fails.
            try:
                self._conn.close()
            except Exception:
                pass

    # psycopg2 connections support `with conn:` as a transaction scope
    # (commits on success, rollbacks on exception). Delegate so existing
    # code that uses this pattern keeps working.
    def __enter__(self):
        return self._conn.__enter__()

    def __exit__(self, exc_type, exc, tb):
        return self._conn.__exit__(exc_type, exc, tb)

    # Everything else — cursor(), commit(), rollback(), .closed, etc.
    # — delegates straight through to the wrapped connection.
    def __getattr__(self, name):
        return getattr(self._conn, name)


def _borrow_validated(pool: ThreadedConnectionPool):
    """Borrow a connection from `pool` after validating it with a cheap
    `SELECT 1`. If the borrowed conn is dead (server-side session
    killed by the Supabase pooler after idle timeout, or any other
    silent drop that TCP keepalives don't catch), drop it and retry
    once with a fresh borrow.

    This is the standard "test-on-borrow" pattern that mature pools
    implement (SQLAlchemy's `pool_pre_ping=True` is the equivalent).
    psycopg2's ThreadedConnectionPool is passive — it lends conns
    without checking liveness — so we add the check at the borrow
    site. Cost is one round-trip per request (~0.3 ms in-region),
    paid in exchange for never serving a dead conn to a caller.
    """
    for attempt in (0, 1):
        raw = pool.getconn()
        try:
            # `closed` is 0 for an open conn; non-zero values mean it
            # was closed locally. We catch that cheaply before any
            # network I/O.
            if raw.closed:
                pool.putconn(raw, close=True)
                continue
            cur = raw.cursor()
            try:
                cur.execute("SELECT 1")
                cur.fetchone()
                # Override the session statement_timeout if the env var
                # is set (worker only — see _DB_STATEMENT_TIMEOUT above).
                # Cheap (no round-trip beyond what we already pay) and
                # idempotent: re-applying the same value on a reused
                # conn is a no-op for Postgres.
                if _DB_STATEMENT_TIMEOUT:
                    cur.execute(
                        f"SET statement_timeout = '{_DB_STATEMENT_TIMEOUT}'"
                    )
            finally:
                cur.close()
            # Drop any aborted-tx state from the prior renter.
            raw.rollback()
            return raw
        except psycopg2.Error:
            # Server-side drop, broken pipe, SSL closed, anything that
            # makes this conn unusable. Drop it from the pool so it
            # doesn't get lent again, then retry one fresh borrow.
            try:
                pool.putconn(raw, close=True)
            except Exception:
                pass
            if attempt == 1:
                raise
    # Unreachable: the loop either returns or raises.
    raise RuntimeError("pool pre-ping retries exhausted")


def get_connection() -> "_PooledConnection":
    """Borrow a connection from the default pool (DATABASE_URL).
    Calling `.close()` on the returned object returns it to the pool —
    existing callers don't need to change.

    Use this everywhere by default. The connection MAY be served through
    a transaction pooler (e.g., Supabase pgBouncer on port 6543) so the
    caller must avoid session-level features: no `pg_advisory_lock`,
    no `LISTEN/NOTIFY`, no explicit prepared statements. Short transactions
    (INSERT / UPDATE / SELECT) work transparently."""
    pool = _ensure_pool()
    raw = _borrow_validated(pool)
    return _PooledConnection(raw, pool)


def get_direct_connection() -> "_PooledConnection":
    """Borrow a direct (non-pooler) connection. Required for session-level
    features like `pg_try_advisory_lock` — see the module docstring.

    Backed by `DATABASE_URL_DIRECT` if set, else falls back to
    `DATABASE_URL`. On the worker service `DATABASE_URL` already points at
    the direct URL so the fallback yields the right behavior; the explicit
    override exists for setups that need both modes side-by-side on the
    same service."""
    pool = _ensure_direct_pool()
    raw = _borrow_validated(pool)
    return _PooledConnection(raw, pool)


def close_pool() -> None:
    """Close every connection in both pools. Hooked into FastAPI's lifespan
    teardown so the process exits cleanly without leaking sockets."""
    global _POOL, _DIRECT_POOL
    if _POOL is not None:
        _POOL.closeall()
        _POOL = None
    if _DIRECT_POOL is not None:
        _DIRECT_POOL.closeall()
        _DIRECT_POOL = None
