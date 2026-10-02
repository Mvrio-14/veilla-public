"""
FastAPI server — read-only data API for the Veilla SPA.

Exposes:
  - /                            : minimal landing
  - /health                      : liveness check
  - /users/{slug}/watch          : the user's current Watch, in JSON,
                                   ready for the SPA
  - authed /me/* + /stories/{id}/{action} : per-user state, prefs, feeds,
                                   notifications, views, folders (see route
                                   decorators below).

At app startup: sync catalog -> DB (idempotent). The continuous ingest
pipeline (collect → normalize → embed → cluster → label) lives in a
separate Render Background Worker service (`python -m src.runner`).
"""
import hmac
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from src.catalog_sync import sync_catalog_to_db
from src.db import close_pool, get_connection
from src.observability import init_sentry
from src.routes import admin as admin_routes
from src.routes import me as me_routes
from src.routes import public as public_routes
from src.routes import signal as signal_routes
from src.routes import stories as stories_routes
from src.write_access import write_access_middleware

# ── Lifespan ────────────────────────────────────────────────────────────────
# Lazy MCP sub-app reference — populated at import time below, consumed
# inside the lifespan to chain its session-manager lifespan into ours.
# The MCP StreamableHTTPSessionManager requires an active task group,
# which is created only when its own Starlette lifespan runs; without
# chaining, `POST /mcp` raises `Task group is not initialized`.
_mcp_sub_app = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Errors-only Sentry; no-op unless SENTRY_DSN is set. sentry-sdk detects
    # FastAPI and captures unhandled 500s automatically once initialised.
    init_sentry("api")

    # ── Catalog sync gate ────────────────────────────────────────────
    #
    # The /admin/* UI writes feeds, sources and users to the database,
    # which is the source of truth once an environment exists. Running
    # `sync_catalog_to_db` on every boot would silently overwrite those
    # edits with whatever `config/catalog.json` holds — a real risk
    # whenever the snapshot file drifts from the live DB.
    #
    # So the rule is: catalog_sync runs ONLY when the `catalog` table is
    # empty (= brand-new env / first deploy). On a populated DB the
    # sync is skipped entirely and the message in the logs makes that
    # explicit.
    #
    # Override knobs (in order of precedence):
    #   - `SKIP_CATALOG_SYNC=1`     → unconditional skip (local dev, tests)
    #   - `FORCE_CATALOG_SYNC=1`    → unconditional run (rare — only when
    #                                 you deliberately want to clobber the
    #                                 DB with the JSON snapshot; e.g. a
    #                                 staging env you just nuked and want
    #                                 to rebuild from git).
    # The sync is decided and run first; the lifespan then yields once,
    # at the end, so the MCP sub-app's lifespan can be chained into it.
    run_catalog_sync = False
    if os.environ.get("SKIP_CATALOG_SYNC", "").lower() in {"1", "true", "yes"}:
        print("[api] SKIP_CATALOG_SYNC set — skipping catalog sync at boot")
    else:
        force = os.environ.get("FORCE_CATALOG_SYNC", "").lower() in {"1", "true", "yes"}
        conn = get_connection()
        try:
            cur = conn.cursor()
            cur.execute("SELECT 1 FROM catalog LIMIT 1")
            catalog_populated = cur.fetchone() is not None
        finally:
            conn.close()

        if catalog_populated and not force:
            print(
                "[api] catalog already populated — skipping catalog sync. "
                "DB is the source of truth post-bootstrap; edit via /admin/*. "
                "Set FORCE_CATALOG_SYNC=1 to override."
            )
        else:
            if catalog_populated and force:
                print("[api] FORCE_CATALOG_SYNC=1 set on a populated DB — running anyway. "
                      "This may overwrite admin UI edits with config/catalog.json values.")
            else:
                print("[api] catalog empty — bootstrapping from config/catalog.json")
            run_catalog_sync = True

    if run_catalog_sync:
        sync_catalog_to_db(verbose=True)
        print("[api] catalog sync done — serving requests")

    # Chain the MCP sub-app's own lifespan so its session-manager task
    # group is active while we serve requests. Its shutdown runs before
    # ours on exit. Falls back to a bare yield when MCP mount failed
    # (`_mcp_sub_app is None`) so the API can still boot without it.
    try:
        if _mcp_sub_app is not None:
            async with _mcp_sub_app.router.lifespan_context(_mcp_sub_app):
                yield
        else:
            yield
    finally:
        close_pool()


# `redirect_slashes=False` turns off the automatic 307 that
# FastAPI/Starlette issues on a trailing slash. The MCP sub-app is
# mounted at `/mcp` with its own route at `/`, which makes `/mcp/` the
# real URL and `/mcp` a 307 towards it — and many HTTP clients refuse to
# follow a redirect on a POST, because whether the body survives is
# ambiguous. With this flag, `/mcp` without the slash is a plain 404
# rather than false hope, and `/mcp/` hits FastMCP directly: `/mcp/` is
# the one canonical URL.
app = FastAPI(
    title="Veilla API", version="0.2.0", lifespan=lifespan,
    redirect_slashes=False,
)


# ── Middleware ──────────────────────────────────────────────────────────────
# Per-request timing log. Cheap and one-shot per request — useful in dev to
# spot which endpoint is the bottleneck without adding a profiler. Logs as
# `[123ms] GET /me/saved → 200`. OPTIONS preflights are skipped (always
# trivial, would clutter the log).
@app.middleware("http")
async def log_request_timing(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000
    print(
        f"[{duration_ms:7.0f}ms] {request.method:6} {request.url.path}"
        f" → {response.status_code}",
        flush=True,
    )
    return response


# GZip the response body when the client accepts it (every browser does).
# Cuts /watch payload from ~1.4 MB to ~350 KB on the wire.
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Write access — every mutating request is refused unless the caller is on
# the pro plan (`users.plan`). See src/write_access.py
# for why this is one middleware rather than a guard on each of the write
# endpoints.
#
# Registered BEFORE CORS on purpose. Starlette runs the last-registered
# middleware outermost, so adding CORS after this one puts CORS on the
# outside, where it can attach headers to the 401/403 raised here. Reversed,
# the browser reports an opaque network failure instead of the real status.
app.middleware("http")(write_access_middleware)

# CORS — restricted to the Veilla SPA origins. Auth is via Bearer token
# (not cookies), so allow_credentials stays False; a third-party site
# therefore can't read a victim's authed responses even if it calls us.
# Locking origins is defense-in-depth + blocks casual browser-based abuse.
#
#   - Production domain(s): overridable via CORS_ALLOWED_ORIGINS (comma-sep)
#     so we can add/remove without a code change.
#   - Vercel preview deploys (https://<branch>-<hash>.vercel.app): matched by
#     regex so per-branch previews keep working against this API.
#   - localhost:3000 for local `npm run dev` against a remote/local API.
_default_origins = "https://veilla.io,https://www.veilla.io,http://localhost:3000"
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("CORS_ALLOWED_ORIGINS", _default_origins).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https://[a-z0-9-]+\.vercel\.app",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# ── MCP over HTTP (2026-07 — for remote MCP clients) ────────────────────────
#
# The Veilla MCP server (`mcp_server/server.py`) doubles as an HTTP
# endpoint mounted here at `/mcp`. Same tool set as the local stdio
# path (used by Claude Desktop) — the two transports co-exist without
# interference.
#
# Auth is a shared bearer token in `MCP_SHARED_TOKEN`: one token, one
# logical caller — the single user named by VEILLA_MCP_USER_SLUG. Opening
# the endpoint to several users means per-user tokens, and a per-token
# rate limit with them.
#
# When `MCP_SHARED_TOKEN` is unset the endpoint answers 503, so a
# misconfigured deploy never exposes tools that spend money (OpenAI
# calls, database writes).
_MCP_TOKEN = os.environ.get("MCP_SHARED_TOKEN")


@app.middleware("http")
async def mcp_auth_gate(request: Request, call_next):
    """Guard `/mcp*` with a bearer token check.

    Every other route bypasses this middleware. Placed BEFORE the mount
    so unauthorized requests never reach the FastMCP handler.
    """
    if not request.url.path.startswith("/mcp"):
        return await call_next(request)

    if not _MCP_TOKEN:
        return JSONResponse(
            {"error": "mcp_disabled",
             "detail": "Set MCP_SHARED_TOKEN on the API to enable this endpoint."},
            status_code=503,
        )

    # Three accepted forms, because third-party client UIs (Claude
    # Desktop, Zapier, voice agents) handle headers differently:
    #
    #   1. `Authorization: Bearer <token>`
    #   2. `Authorization: <token>` — what some clients send when the
    #      stored secret is the token alone.
    #   3. `?token=<token>` — for UIs that cannot set a header at all.
    #
    # The header wins over the query parameter.
    supplied = None
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        supplied = auth.split(" ", 1)[1].strip()
    elif auth:
        supplied = auth
    if not supplied:
        supplied = (request.query_params.get("token") or "").strip() or None

    if not supplied:
        return JSONResponse(
            {"error": "unauthorized",
             "detail": "Missing Bearer token or ?token= query param."},
            status_code=401,
        )
    # Constant time, so the comparison does not reveal how much of a
    # guess was right.
    if not hmac.compare_digest(supplied.encode(), _MCP_TOKEN.encode()):
        # Which form the client used, never what it sent: a rejected
        # token is often a real one with a typo, or last month's.
        form = ("header" if request.headers.get("authorization")
                else "query" if request.query_params.get("token") else "none")
        print(f"[mcp-auth] rejected token on {request.url.path} (via {form})", flush=True)
        return JSONResponse(
            {"error": "unauthorized", "detail": "Invalid token."},
            status_code=401,
        )

    return await call_next(request)


# Mount the FastMCP streamable-HTTP app under `/mcp`. The `mcp` object
# carries every tool + resource registered in `mcp_server/server.py` —
# both transport paths (stdio + HTTP) expose the same surface.
#
# We capture the sub-app instance in the module-level `_mcp_sub_app`
# variable so the `lifespan` above can chain its session-manager
# lifespan — mandatory or the first POST /mcp raises "Task group is
# not initialized".
try:
    from mcp_server.server import mcp as _mcp_server
    _mcp_sub_app = _mcp_server.streamable_http_app()
    app.mount("/mcp", _mcp_sub_app)
    # The canonical URL is `/mcp/`, trailing slash included — the only
    # one that reaches the FastMCP handler without a redirect. Printed
    # that way so nobody copies `/mcp` out of the logs and meets a 404.
    print("[api] MCP mounted at /mcp/ "
          f"(auth: {'enabled' if _MCP_TOKEN else 'DISABLED — set MCP_SHARED_TOKEN'})")
except Exception as e:
    # Non-fatal — the API keeps serving even if MCP has an import error.
    # A misconfigured MCP mount shouldn't take down /watch.
    print(f"[api] WARN — MCP mount failed: {type(e).__name__}: {e}")


# ── Routes ─────────────────────────────────────────────────────────────────
# One APIRouter per domain, in src/routes/. The admin router declares
# `require_admin` itself, so an admin route cannot be added unprotected —
# see src/routes/admin.py. Every admin mutation writes an `admin_actions`
# row, readable at /admin/audit.
app.include_router(admin_routes.router)
app.include_router(public_routes.router)
app.include_router(me_routes.router)
app.include_router(signal_routes.router)
app.include_router(stories_routes.router)
