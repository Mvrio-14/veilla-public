"""
Admin routes — the operator's surface over sources, feeds, users and
the audit trail.

## Why the dependency sits on the router

`require_admin` is declared once, on the router, so every route below
it is closed by default. Each handler *also* takes it as a parameter,
because nearly all of them need the caller's identity to write an audit
row — the parameter is how they receive the value, the router-level
declaration is what guarantees nobody can forget it.

That redundancy is the point. The next admin route, added by somebody
who never read this file, is protected whether or not they remember the
parameter. It is the same reasoning as the write-access
middleware in `src/write_access.py`, applied one layer up.
"""
from __future__ import annotations

import psycopg2.errors
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel

from src.admin import feeds_sources as _fs
from src.admin import users as _users
from src.admin.audit import list_actions as _audit_list
from src.admin.audit import log_action as _audit
from src.admin.auth import require_admin
from src.admin.probe import probe_url as _probe_url
from src.admin.validation import validate_country as _v_country
from src.admin.validation import validate_email as _v_email
from src.admin.validation import validate_lang as _v_lang
from src.admin.validation import validate_slug as _v_slug
from src.auth import AuthContext, resolve_user_id
from src.db import get_connection
from src.routes._shared import DATA_CACHE_PRIVATE
from src.templates import FetchError, TemplateError, get_template

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


def _admin_validate(fn, value):
    """Run a validator (`_v_country`, `_v_lang`, `_v_slug`) and convert
    any `ValueError` to an HTTP 400 with the validator's message — the
    SPA renders this inline next to the offending field.
    """
    try:
        return fn(value)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/me")
def get_admin_me(
    response: Response,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Heartbeat for the admin surface. Returns the authed admin's email
    + their public.users id (resolved lazy). The frontend uses this on
    /admin mount to verify access before rendering the shell — a 200
    response means the JWT is valid AND the email is whitelisted."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        user_id = resolve_user_id(conn, auth)
    finally:
        conn.close()
    return {
        "email":   auth.email,
        "user_id": user_id,
        "is_admin": True,  # the dep already verified — kept as a stable
                            # contract so the SPA doesn't have to infer
                            # admin-ness from a 200 alone.
    }


# ── Sources & Feeds (read) ────────────────────────────────────────────
@router.get("/sources")
def admin_list_sources(
    response: Response,
    include_dead: bool = Query(False, description="Include sources whose feeds are all dead — by default the UI shows only live sources but the toggle is here for cleanup work."),
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """List all catalog sources with a feed-count summary."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        sources = _fs.list_sources(cur)
        if not include_dead:
            sources = [s for s in sources if s["n_feeds_alive"] > 0 or s["n_feeds_dead"] == 0]
    finally:
        conn.close()
    return {"sources": sources}


@router.get("/feeds")
def admin_list_feeds(
    response: Response,
    source_id:    int  | None = Query(None, description="Filter to one source."),
    include_dead: bool        = Query(False, description="When false, exclude feeds whose monitor is dead."),
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """List feeds — flat. The SPA Sources page nests them under their
    source in the rendering; this endpoint stays flat so other consumers
    (audit, future bulk ops) can query freely."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        feeds = _fs.list_feeds(cur, source_id=source_id, include_dead=include_dead)
    finally:
        conn.close()
    return {"feeds": feeds}


# ── Sources mutations ─────────────────────────────────────────────────
class _SourceCreateBody(BaseModel):
    model_config = {"extra": "forbid"}
    name:           str
    domain:         str
    country:        str | None = None
    paywall_policy: str | None = None
    robots_skip:    bool       = False


class _SourceUpdateBody(BaseModel):
    model_config = {"extra": "forbid"}
    name:           str | None  = None
    country:        str | None  = None
    paywall_policy: str | None  = None
    robots_skip:    bool | None = None


@router.post("/sources", status_code=201)
def admin_create_source(
    body: _SourceCreateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Manually create a source. Most sources are created on the fly via
    `POST /admin/feeds` (the probe flow seeds them when a new domain is
    seen). This endpoint exists for the case where the admin wants the
    source row before any feed lands (e.g. preparing an upcoming launch)."""
    country = _admin_validate(_v_country, body.country)
    conn = get_connection()
    try:
        cur = conn.cursor()
        if _fs.get_source_by_domain(cur, body.domain) is not None:
            raise HTTPException(status_code=409, detail=f"Source with domain {body.domain!r} already exists")
        source = _fs.create_source(
            cur,
            name           = body.name.strip(),
            domain         = body.domain.strip().lower(),
            country        = country,
            paywall_policy = body.paywall_policy,
            robots_skip    = body.robots_skip,
        )
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "create_source",
            target_type   = "source",
            target_id     = str(source["id"]),
            payload       = {"data": source},
        )
        conn.commit()
    finally:
        conn.close()
    return source


@router.put("/sources/{source_id}")
def admin_update_source(
    source_id: int,
    body: _SourceUpdateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    conn = get_connection()
    try:
        cur = conn.cursor()
        before_list = _fs.list_sources(cur)
        before = next((s for s in before_list if s["id"] == source_id), None)
        if before is None:
            raise HTTPException(status_code=404, detail=f"Source {source_id} not found")
        after = _fs.update_source(
            cur,
            source_id,
            name           = body.name.strip() if body.name else None,
            country        = _admin_validate(_v_country, body.country) if body.country is not None else None,
            paywall_policy = body.paywall_policy,
            robots_skip    = body.robots_skip,
        )
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "update_source",
            target_type   = "source",
            target_id     = str(source_id),
            payload       = {"before": before, "after": after},
        )
        conn.commit()
    finally:
        conn.close()
    return after


# ── Feeds: probe + mutations ──────────────────────────────────────────
class _FeedProbeBody(BaseModel):
    model_config = {"extra": "forbid"}
    url: str


@router.post("/feeds/probe")
def admin_probe_feed(
    body: _FeedProbeBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Fetch + parse a URL without touching the DB. UI displays the
    preview then either confirms (`POST /admin/feeds`) or cancels."""
    result = _probe_url(body.url)
    return result.to_dict()


class _FeedCreateBody(BaseModel):
    model_config = {"extra": "forbid"}
    url:        str
    name:       str
    slug:       str | None = None  # UI generated, editable; if absent
                                    # we derive from source+name
    feed_type:  str | None = None
    # Semantically a LANGUAGE code (ISO 639-1 lowercase: fr, en, ...) — the
    # column is historically named `country` for legacy reasons but holds
    # the feed's content language. Renaming is deferred to its own migration.
    country:    str | None = None
    # When source_id is set, attach to that source. When source_id is
    # null, the URL's domain is looked up; if no source matches, we
    # create one inline using the source_* fields below.
    source_id:             int  | None = None
    source_name:           str  | None = None
    # New source seeding fields (only consulted when we create the source
    # on the fly). Distinct from `country` above (= feed language). The
    # frontend pre-fills these with sensible defaults but the admin can
    # override before clicking Save.
    source_domain:         str  | None = None
    source_country:        str  | None = None   # ISO 3166-1 alpha-2 uppercase
    source_paywall_policy: str  | None = None   # "free" | "paywall" | "mixed" | None
    source_robots_skip:    bool        = False


@router.post("/feeds", status_code=201)
def admin_create_feed(
    body: _FeedCreateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Save the previewed feed. Two source-resolution paths:
       - explicit `source_id` → attach there
       - else look up `sources` by URL-derived domain; create if missing
         (requires `source_name` in that case)."""
    # Validate the inputs that have a closed allowed-set BEFORE we touch
    # the DB — fail fast so a bad code surfaces as 400 with a clear
    # message instead of polluting the catalog with garbage.
    feed_lang     = _admin_validate(_v_lang,    body.country)
    seed_country  = _admin_validate(_v_country, body.source_country)
    custom_slug   = _admin_validate(_v_slug,    body.slug)
    conn = get_connection()
    try:
        cur = conn.cursor()

        # ── Resolve source ───────────────────────────────────────────
        source_id = body.source_id
        if source_id is None:
            # Source domain: caller-provided OR derived from URL. We let
            # the admin override (rare but useful e.g. `rss.lemonde.fr`
            # where the desired source bucket is `lemonde.fr`).
            domain = (body.source_domain or _fs.derive_domain(body.url)).strip().lower()
            if not domain:
                raise HTTPException(status_code=400, detail="URL has no parseable domain — pass source_id explicitly.")
            existing = _fs.get_source_by_domain(cur, domain)
            if existing:
                source_id = existing["id"]
            else:
                if not body.source_name:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Domain {domain!r} is new — pass source_name to seed the source row.",
                    )
                # `source_country` (a real country) is distinct from `country`
                # (the feed's language). When the admin didn't fill the
                # source country, leave NULL rather than reusing the lang
                # code — silently mapping `fr` lang to `FR` country would
                # mis-tag every English Le Monde feed as French publisher.
                created_source = _fs.create_source(
                    cur,
                    name           = body.source_name.strip(),
                    domain         = domain,
                    country        = seed_country,
                    paywall_policy = body.source_paywall_policy or None,
                    robots_skip    = body.source_robots_skip,
                )
                _audit(
                    cur,
                    actor_user_id = resolve_user_id(conn, auth),
                    action        = "create_source",
                    target_type   = "source",
                    target_id     = str(created_source["id"]),
                    payload       = {"data": created_source, "via": "feed_create_inline"},
                )
                source_id = created_source["id"]

        # ── Lookup source name for slug derivation ──────────────────
        cur.execute("SELECT name FROM sources WHERE id = %s", (source_id,))
        src_row = cur.fetchone()
        source_name = src_row[0] if src_row else None

        slug = (custom_slug or _fs.derive_feed_slug(source_name, body.name, body.url)).strip()
        if not slug:
            raise HTTPException(status_code=400, detail="Slug could not be derived; provide one explicitly.")

        # ── Insert feed ──────────────────────────────────────────────
        try:
            feed = _fs.create_feed(
                cur,
                slug      = slug,
                name      = body.name.strip(),
                template  = "rss",
                config    = {"url": body.url.strip()},
                source_id = source_id,
                feed_type = body.feed_type,
                country   = feed_lang,
            )
        except TemplateError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except psycopg2.errors.UniqueViolation as e:
            conn.rollback()
            raise HTTPException(status_code=409, detail=f"Slug or URL already exists: {e}")

        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "create_feed",
            target_type   = "feed",
            target_id     = str(feed["id"]),
            payload       = {"data": feed},
        )
        conn.commit()
    finally:
        conn.close()
    return feed


class _FeedUpdateBody(BaseModel):
    model_config = {"extra": "forbid"}
    slug:      str | None = None
    name:      str | None = None
    url:       str | None = None
    feed_type: str | None = None
    country:   str | None = None
    source_id: int | None = None
    starter:   bool | None = None


@router.put("/feeds/{feed_id}")
def admin_update_feed(
    feed_id: int,
    body: _FeedUpdateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    new_slug = _admin_validate(_v_slug, body.slug) if body.slug is not None else None
    new_lang = _admin_validate(_v_lang, body.country) if body.country is not None else None
    conn = get_connection()
    try:
        cur = conn.cursor()
        before = _fs.get_feed(cur, feed_id)
        if before is None:
            raise HTTPException(status_code=404, detail=f"Feed {feed_id} not found")
        try:
            after = _fs.update_feed(
                cur, feed_id,
                slug      = new_slug,
                name      = body.name.strip() if body.name else None,
                url       = body.url.strip()  if body.url  else None,
                feed_type = body.feed_type,
                country   = new_lang,
                source_id = body.source_id,
                starter   = body.starter,
            )
        except TemplateError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except psycopg2.errors.UniqueViolation as e:
            conn.rollback()
            raise HTTPException(status_code=409, detail=f"Slug or URL already exists: {e}")
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "update_feed",
            target_type   = "feed",
            target_id     = str(feed_id),
            payload       = {"before": before, "after": after},
        )
        conn.commit()
    finally:
        conn.close()
    return after


class _FeedStatusBody(BaseModel):
    model_config = {"extra": "forbid"}
    status: str  # active | degraded | dead


@router.patch("/feeds/{feed_id}/status")
def admin_set_feed_status(
    feed_id: int,
    body: _FeedStatusBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Move a feed between active/degraded/dead. UI uses this for
    soft-delete (→ dead) and resurrect (→ active)."""
    conn = get_connection()
    try:
        cur = conn.cursor()
        before = _fs.get_feed(cur, feed_id)
        if before is None:
            raise HTTPException(status_code=404, detail=f"Feed {feed_id} not found")
        try:
            after = _fs.set_feed_status(cur, feed_id, body.status)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        action = (
            "resurrect_feed"   if body.status == "active"   and before["status"] == "dead" else
            "soft_delete_feed" if body.status == "dead" else
            "update_feed_status"
        )
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = action,
            target_type   = "feed",
            target_id     = str(feed_id),
            payload       = {"before": before, "after": after},
        )
        conn.commit()
    finally:
        conn.close()
    return after


# ── Google News queries ───────────────────────────────────────────────
# Catalog entries with the `google_news` template are created through their own
# flow rather than `/admin/feeds`: source_id is NULL, since the feed is
# multi-publisher by nature, and the URL is derived from a query plus a
# language and a country rather than typed in.


class _GNPreviewBody(BaseModel):
    """Preview the last five items of a Google News query before
    saving. Used by the UI creation flow and by the MCP tool to
    validate an agent's composition."""
    model_config = {"extra": "forbid"}
    query: str
    hl:    str = "fr"
    gl:    str = "FR"
    ceid:  str | None = None
    limit: int = 5


@router.post("/feeds/google_news_query/preview")
def admin_gn_query_preview(
    body: _GNPreviewBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Preview the first items a Google News query returns. Zero DB
    write — the `google_news` template's own fetch, nothing stored.

    Returns:
        {url, count, items: [{title, source_name, source_domain, link,
                              published_at}], warning}
    """
    config = {"query": body.query, "hl": body.hl, "gl": body.gl, "ceid": body.ceid}
    result = _gn_preview(config)
    limit = max(1, min(int(body.limit or 5), 25))
    return {
        "url":     get_template("google_news").normalize(config)["url"],
        "count":   len(result.items),
        "items":   [
            {
                "title":         item.title,
                "source_name":   item.source_name,
                "source_domain": item.source_domain,
                "link":          item.url,
                "published_at":  item.published_at,
            }
            for item in result.items[:limit]
        ],
        "warning": None if result.items else (
            "No items returned. The query may be too narrow, use "
            "unsupported syntax, or have no recent matches."
        ),
    }


def _gn_preview(config: dict):
    """The `google_news` template's preview, as HTTP errors: a bad query is
    the caller's (400), a Google failure is upstream's (502)."""
    try:
        return get_template("google_news").preview(config)
    except TemplateError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FetchError as e:
        raise HTTPException(status_code=502, detail=f"Google News fetch failed: {e}")


class _GNCreateBody(BaseModel):
    """Payload for creating a Google News feed.

    Unlike `_FeedCreateBody`, there is no `source_id` — the publisher
    is resolved per item at ingest time from the `<source>` tag.
    """
    model_config = {"extra": "forbid"}
    name:  str
    query: str
    hl:    str = "fr"
    gl:    str = "FR"
    ceid:  str | None = None
    # Optional — derived from the name otherwise.
    slug:  str | None = None


@router.post("/feeds/google_news_query", status_code=201)
def admin_gn_query_create(
    body: _GNCreateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Create a catalog entry with the `google_news` template.

    Flow :
      1. Validate query non-empty.
      2. Smoke-test: fetch it once through the template. A bad config
         → 400, Google failing → 502. No items yet is fine.
      3. Insert the entry with source_id=NULL, template='google_news',
         config={query, hl, gl, ceid}.
      4. Nobody follows it yet: flag it `starter` for new accounts to
         follow it.
    """
    name  = (body.name  or "").strip()
    query = (body.query or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required.")
    if not query:
        raise HTTPException(status_code=400, detail="Query is required.")

    # Smoke-test: the query must fetch. It may return nothing yet — the
    # news it watches for can come later.
    _gn_preview({"query": query, "hl": body.hl, "gl": body.gl, "ceid": body.ceid})

    # Slug, derived from the name when not supplied. The `gn-` prefix
    # keeps two feeds the user gave the same name — one RSS, one Google
    # News — from colliding.
    if body.slug:
        slug = _admin_validate(_v_slug, body.slug)
    else:
        from src.admin.feeds_sources import slugify
        slug = "gn-" + (slugify(name) or "query")

    conn = get_connection()
    try:
        cur = conn.cursor()
        try:
            feed = _fs.create_feed(
                cur,
                slug      = slug,
                name      = name,
                template  = "google_news",
                config    = {"query": query, "hl": body.hl, "gl": body.gl, "ceid": body.ceid},
                source_id = None,               # multi-publisher by design
                feed_type = None,
                country   = body.hl.lower(),    # the content language
            )
        except Exception as e:
            # Very likely a UNIQUE (slug) or UNIQUE (url) conflict — one
            # or the other means "this query already exists".
            raise HTTPException(
                status_code=409,
                detail=f"Could not create feed (probably a duplicate): {e}",
            )
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "create_feed_google_news_query",
            target_type   = "feed",
            target_id     = str(feed["id"]),
            payload       = {"data": feed, "query": query, "hl": body.hl, "gl": body.gl},
        )
        conn.commit()
    finally:
        conn.close()

    return feed


# ── Users ──────────────────────────────────────────────────────────────
@router.get("/users")
def admin_list_users(
    response: Response,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """List every public.users row."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        users = _users.list_users(cur)
    finally:
        conn.close()
    return {"users": users}


@router.get("/users/{user_id}")
def admin_get_user(
    response: Response,
    user_id: str,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        user = _users.get_user(cur, user_id)
        if user is None:
            raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    finally:
        conn.close()
    return user


class _UserCreateBody(BaseModel):
    model_config = {"extra": "forbid"}
    slug:        str
    email:       str
    name:        str  | None = None
    output_lang: str          = "fr"
    active:      bool         = True
    is_public:   bool         = False
    plan:        str          = "demo"


def _validate_plan(plan: str) -> str:
    if plan not in _users.PLANS:
        raise HTTPException(
            status_code=400,
            detail=f"plan must be one of {sorted(_users.PLANS)}, got {plan!r}",
        )
    return plan


@router.post("/users", status_code=201)
def admin_create_user(
    body: _UserCreateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Create a public.users row.

    Does NOT create the Supabase Auth account — the admin still needs
    to go through the Supabase Dashboard for that. The `auth_id` will
    link lazily at first login via email match.

    Validation:
      - `slug`  must match the kebab-case regex (see validation.py).
      - `email` must look like an email.
      - `output_lang` must be in the allowed ISO 639-1 whitelist.
      - 409 on slug or email collision (pre-flight check).
    """
    slug  = _admin_validate(_v_slug,  body.slug)
    email = _admin_validate(_v_email, body.email)
    lang  = _admin_validate(_v_lang,  body.output_lang)
    plan  = _validate_plan(body.plan)
    conn = get_connection()
    try:
        cur = conn.cursor()
        if _users.get_user_by_slug(cur, slug) is not None:
            raise HTTPException(status_code=409, detail=f"Slug {slug!r} already in use")
        if _users.get_user_by_email(cur, email) is not None:
            raise HTTPException(status_code=409, detail=f"Email {email!r} already in use")
        try:
            user = _users.create_user(
                cur,
                slug        = slug,
                email       = email,
                name        = body.name.strip() if body.name else None,
                output_lang = lang,
                active      = body.active,
                is_public   = body.is_public,
                plan        = plan,
            )
        except psycopg2.errors.UniqueViolation as e:
            conn.rollback()
            raise HTTPException(status_code=409, detail=str(e))
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "create_user",
            target_type   = "user",
            target_id     = user["id"],
            payload       = {"data": user},
        )
        conn.commit()
    finally:
        conn.close()
    return user


class _UserUpdateBody(BaseModel):
    model_config = {"extra": "forbid"}
    name:        str  | None = None
    slug:        str  | None = None
    email:       str  | None = None
    output_lang: str  | None = None
    active:      bool | None = None
    is_public:   bool | None = None
    plan:        str  | None = None


@router.put("/users/{user_id}")
def admin_update_user(
    user_id: str,
    body: _UserUpdateBody,
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Edit user profile fields. Each kwarg is opt-in.

    Caveats (also surfaced inline in the SPA):
      - `slug` change breaks deep links and legacy `config/users/<slug>/`
        file paths. Use only on freshly-onboarded accounts.
      - `email` change does NOT update the Supabase Auth login — that
        still happens via the Dashboard. This field is cosmetic /
        notification-target only post-mismatch.
    """
    lang  = _admin_validate(_v_lang,  body.output_lang) if body.output_lang is not None else None
    slug  = _admin_validate(_v_slug,  body.slug)        if body.slug        is not None else None
    email = _admin_validate(_v_email, body.email)       if body.email       is not None else None
    plan  = _validate_plan(body.plan)                   if body.plan        is not None else None
    conn = get_connection()
    try:
        cur = conn.cursor()
        before = _users.get_user(cur, user_id)
        if before is None:
            raise HTTPException(status_code=404, detail=f"User {user_id} not found")
        # Pre-flight uniqueness: a clean 409 beats a raw IntegrityError
        # bubbling up from the UPDATE. Skip when the slug isn't actually
        # changing (= user re-saves the form without editing the slug).
        if slug is not None and slug != before["slug"]:
            existing = _users.get_user_by_slug(cur, slug)
            if existing and existing["id"] != user_id:
                raise HTTPException(status_code=409, detail=f"Slug {slug!r} already in use")
        try:
            after = _users.update_user(
                cur, user_id,
                name        = body.name.strip() if body.name else None,
                slug        = slug,
                email       = email,
                output_lang = lang,
                active      = body.active,
                is_public   = body.is_public,
                plan        = plan,
            )
        except psycopg2.errors.UniqueViolation as e:
            conn.rollback()
            raise HTTPException(status_code=409, detail=str(e))
        _audit(
            cur,
            actor_user_id = resolve_user_id(conn, auth),
            action        = "update_user",
            target_type   = "user",
            target_id     = user_id,
            payload       = {"before": before, "after": after},
        )
        conn.commit()
    finally:
        conn.close()
    return after


@router.get("/audit")
def admin_list_audit(
    response: Response,
    actor_user_id: str | None = Query(None, description="Filter to actions by this user UUID."),
    action:        str | None = Query(None, description="Filter to one action verb (e.g. `soft_delete_feed`)."),
    target_type:   str | None = Query(None, description="Filter to one target type (feed / source / user)."),
    target_id:     str | None = Query(None, description="Filter to one specific target id."),
    before_id:     int | None = Query(None, description="Pagination cursor — pass smallest id from the previous page."),
    limit:         int        = Query(100,  ge=1, le=500, description="Page size, capped at 500."),
    auth: AuthContext = Depends(require_admin),
) -> dict:
    """Read the admin_actions log. Newest first. Filters compose with AND;
    pagination is cursor-based via `before_id`."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        cur = conn.cursor()
        actions = _audit_list(
            cur,
            actor_user_id = actor_user_id,
            action        = action,
            target_type   = target_type,
            target_id     = target_id,
            before_id     = before_id,
            limit         = limit,
        )
    finally:
        conn.close()
    return {
        "actions":        actions,
        "next_before_id": actions[-1]["id"] if (actions and len(actions) == limit) else None,
        "has_more":       len(actions) == limit,
    }
