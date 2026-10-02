"""
Routes that are not scoped to the caller's own account.

The service's own signals (`/health`, `/config/retention`,
`/worker/last-pass-ts`) and the watch payload read by slug. Paths differ
too much to share a prefix, so they do not get one.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from src.aggregations import compute_aggregations
from src.auth import AuthContext, get_optional_auth, get_required_auth, resolve_user_id
from src.db import get_connection
from src.loaders.account import load_user_folders, load_user_universe, load_user_views
from src.loaders.common import cluster_recency_max, pub_sort_key
from src.loaders.stories import attach_folder_membership, attach_user_actions_state
from src.loaders.watch import load_read_article_ids, load_watch
from src.monitors import get_user_monitors
from src.pagination import DEFAULT_LIMIT, MAX_LIMIT, paginate_stream
from src.routes._shared import (
    DATA_CACHE_CONTROL,
    DATA_CACHE_PRIVATE,
    WINDOW_HOURS_MAX,
    WINDOW_HOURS_MIN,
    _empty_preferences,
    _normalize_preferences,
)
from src.watch_aggregations import compute_watch_aggregations
from src.watch_query import MAX_PERIOD_HOURS, MIN_PERIOD_HOURS
from src.watch_query import from_request_params as build_watch_query_state

router = APIRouter(tags=["public"])


def _load_user(conn, slug: str) -> dict:
    """
    Look up a user by slug.

    Identity + visibility (id, profile, is_public, auth_id) come from the
    DB users table; `monitors` is what they subscribe to.

    Returns a dict with all the fields the watch endpoint needs.
    Raises: 404 if user is unknown or inactive.
    """
    cur = conn.cursor()
    cur.execute(
        """SELECT id, profile, is_public, auth_id
           FROM users
           WHERE slug = %s AND active = TRUE""",
        (slug,),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"User {slug!r} not found")
    user_id, profile_raw, is_public, auth_id = row
    profile = profile_raw if isinstance(profile_raw, dict) else json.loads(profile_raw or "{}")

    return {
        "id":        str(user_id),
        "profile":   profile,
        "is_public": bool(is_public),
        "auth_id":   str(auth_id) if auth_id else None,
        "monitors":  get_user_monitors(conn, user_id),
    }


@router.get("/")
async def root() -> dict:
    """Minimal landing — keeps Render's default ping out of 404 logs."""
    return {"name": "Veilla API", "version": "0.1.0", "docs": "/docs"}


@router.get("/health")
async def health() -> dict:
    """Liveness check — Render and any uptime monitor hit this."""
    return {"status": "ok"}


@router.get("/config/retention")
async def config_retention() -> dict:
    """Retention parameters the SPA needs to shape its period selector
    and the query editor preview label. Public (no auth) — the values
    are not sensitive and the frontend fetches them at load time on
    every page that displays a period-aware UI.

    Keep this in sync with `src/retention.py` (which is imported here,
    so a code change propagates without touching the endpoint).
    """
    from src.retention import (
        RETENTION_MAX_DAYS,
        RETENTION_MAX_HOURS,
        SPA_PERIOD_DEFAULT_H,
        SPA_PERIOD_PRESETS_H,
    )
    return {
        "max_days":       RETENTION_MAX_DAYS,
        "max_hours":      RETENTION_MAX_HOURS,
        "default_hours":  SPA_PERIOD_DEFAULT_H,
        "preset_hours":   SPA_PERIOD_PRESETS_H,
    }


@router.get("/users/{slug}/watch")
def get_user_watch(
    response: Response,
    slug: str,
    auth: AuthContext | None = Depends(get_optional_auth),
    window_hours: int = Query(24, ge=WINDOW_HOURS_MIN, le=WINDOW_HOURS_MAX,
                              description="Lookback window in hours (2-48). "
                              "Legacy param — superseded by `period_hours` when "
                              "the SPA sends explicit server-side filters."),
    # ─── Server-side filtering ─────────────────────────────────────────────
    # All of the following query params mirror the resolver in
    # `src.watch_query`. Each is OPTIONAL — when nothing is sent, the
    # endpoint falls back to the legacy `window_hours`-only behaviour.
    # Lists are passed as repeated query params (FastAPI binds them
    # automatically): `?keywords=foo&keywords=bar` → ['foo','bar'].
    period_hours: int | None = Query(
        None, ge=MIN_PERIOD_HOURS, le=MAX_PERIOD_HOURS,
        description=(
            f"Lookback window in hours. Overrides `window_hours` and the "
            f"owner's `periodMinutes` preference when set. Range "
            f"{MIN_PERIOD_HOURS}..{MAX_PERIOD_HOURS} (= up to 30 days)."
        ),
    ),
    q: str | None = Query(None, description=(
        "Free-text search query. Postgres FTS via `items.search_vector` "
        "(English stemming). Supports websearch operators: `\"exact phrase\"`, "
        "`-excluded`, `OR`."
    )),
    keywords:               list[str] | None = Query(None),
    excluded_keywords:      list[str] | None = Query(None),
    categories:             list[str] | None = Query(None),
    excluded_categories:    list[str] | None = Query(None),
    article_types:          list[str] | None = Query(None),
    excluded_article_types: list[str] | None = Query(None),
    langs:                  list[str] | None = Query(None),
    feeds:                  list[str] | None = Query(None,
        description="Inclusion filter on feed NAME (exact match). Subset of the user's scope."),
    source_countries:       list[str] | None = Query(None,
        description="Article source country (ISO 3166-1 alpha-2 or regional tag like EUR)."),
    subject_countries:      list[str] | None = Query(None,
        description="Article SUBJECT country (what it's about). Broad codes expand to children."),
    # Entity filters: integer entity_id from `entities.id`.
    persons:                list[int] | None = Query(None),
    orgs:                   list[int] | None = Query(None),
    locations:              list[int] | None = Query(None),
    events:                 list[int] | None = Query(None),
    markets:                list[int] | None = Query(None),
    products:               list[int] | None = Query(None),
    # Lucene-syntax Boolean query (Q4). When non-empty, takes
    # precedence over the per-field inclusion filters above. The
    # frontend sends this in place of persons=… &orgs=… &… when the
    # active saved view was composed in Boolean mode (`views.criteria_text`
    # populated).
    criteria_text: str | None = Query(None, description=(
        "Lucene-syntax Boolean filter. Overrides per-field inclusion "
        "filters when set. See /me/query/compile for syntax."
    )),
    include_closed_stories: bool = Query(False, description=(
        "Include stories that the clusterer has closed (no new article in 36h). "
        "Default false — active stories only, matching the live-feed UX."
    )),
    # ── Pagination / story-type stream ──
    cursor: str | None = Query(
        None,
        description=(
            "Opaque pagination token from a prior /watch response. "
            "Omit to fetch the first page (= newest stories + singletons "
            "interleaved by recency). On first-page responses the payload "
            "carries the full fixed state (views, folders, preferences, "
            "universe, aggs_server). On subsequent pages those "
            "fields are null — the SPA caches them from the first response."
        ),
    ),
    limit: int = Query(
        DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=(
            f"Number of items to return per page. Default {DEFAULT_LIMIT}, "
            f"hard-capped at {MAX_LIMIT}. Stories and singletons count as 1 "
            f"item each in the unified stream."
        ),
    ),
    item_type: str = Query(
        "all",
        regex="^(all|communs|originaux)$",
        description=(
            "Stream filter aligned with the SPA's tabs: 'all' (default) "
            "interleaves both, 'communs' returns only clustered stories, "
            "'originaux' returns only singletons. Changing this requires the "
            "SPA to reset its accumulated page state (= new stream identity)."
        ),
    ),
    quick_filter: str = Query(
        "all",
        regex="^(all|unread|saved|ignored)$",
        description=(
            "Per-user state filter. 'all' = no filter, 'unread' = stories with "
            "an unread article, 'saved' = bookmarked, 'ignored' = hidden. "
            "Applied client-side; currently passes through to the "
            "saved QueryState (used for /aggregations + saved views)."
        ),
    ),
) -> dict:
    """
    Return the user's current "watch" — stories and standalone articles for
    the requested window, ready for the SPA to render.

    Visibility rules:
      - users.is_public = TRUE   → anyone can read (anon OK)
      - users.is_public = FALSE  → only the owner (matched via JWT) can read
                                    401 if anon, 403 if a different authed user

    The response carries a `viewer` block so the frontend knows whether to
    show owner-only UI (save / hide buttons, settings link, etc.).

    # Pagination

    /watch returns a paginated slice of the user's recency-sorted stream.
    The client follows `stats.next_cursor` to load the next page; when
    null, the stream is exhausted. Fixed state (views, folders, etc.) is
    only sent on the first-page response (= when no `cursor` query
    param) — the SPA keeps it across pages.
    """
    conn = get_connection()
    try:
        user = _load_user(conn, slug)

        # Resolve viewer identity (lazy-link auth_id by email on first sight).
        is_owner = False
        if auth is not None:
            viewer_user_id = resolve_user_id(conn, auth)
            is_owner = viewer_user_id == user["id"]

        # Visibility gate.
        if not user["is_public"] and not is_owner:
            if auth is None:
                raise HTTPException(
                    status_code=401,
                    detail="Authentication required to view this watch",
                )
            raise HTTPException(status_code=403, detail="This watch is private")

        monitor_ids = [m["id"] for m in user["monitors"]]

        # Owner preferences override the query-param window_hours when
        # the user has set a custom `periodMinutes`. Non-owners stick to
        # whatever the URL says (= public watch, no per-viewer prefs).
        preferences: dict = _empty_preferences()
        if is_owner:
            cur = conn.cursor()
            cur.execute(
                "SELECT preferences FROM users WHERE id = %s",
                (user["id"],),
            )
            pref_row = cur.fetchone()
            if pref_row and pref_row[0]:
                raw = (
                    pref_row[0]
                    if isinstance(pref_row[0], dict)
                    else json.loads(pref_row[0])
                )
                preferences = _normalize_preferences(raw)
            pref_minutes = int(preferences.get("periodMinutes") or 0)
            if pref_minutes > 0:
                # Convert minutes → hours, ceiling so a 90-min pref maps
                # to a 2h window (rounded up rather than truncated to 1h).
                derived_hours = max(
                    WINDOW_HOURS_MIN,
                    min(WINDOW_HOURS_MAX, (pref_minutes + 59) // 60),
                )
                window_hours = derived_hours

        # ── Build the canonical QueryState from request params ────────
        # Precedence for the period filter:
        #   1. explicit `period_hours` query param (server-side filter)
        #   2. else the (already-derived-from-preferences-or-default)
        #      `window_hours` value above.
        # All other resolver filters come straight from query params.
        # When the SPA hasn't started sending the new params (e.g. an
        # older deploy still on the road), they're all None and the
        # QueryState collapses to "period_hours only" — equivalent to
        # the pre-Pass-2 /watch behaviour.
        effective_period_hours = (
            period_hours if period_hours is not None else window_hours
        )
        # Map paginator's item_type → resolver's scope vocabulary so the
        # saved QueryState is internally consistent. `item_type` itself
        # still drives `paginate_stream` below.
        scope_arg = {
            "all":       "all",
            "communs":   "common",
            "originaux": "original",
        }.get(item_type, "all")
        query_state = build_watch_query_state(
            period_hours           = effective_period_hours,
            q                      = q,
            keywords               = keywords,
            excluded_keywords      = excluded_keywords,
            categories             = categories,
            excluded_categories    = excluded_categories,
            article_types          = article_types,
            excluded_article_types = excluded_article_types,
            langs                  = langs,
            feeds                  = feeds,
            source_countries       = source_countries,
            subject_countries      = subject_countries,
            persons                = persons,
            orgs                   = orgs,
            locations              = locations,
            events                 = events,
            markets                = markets,
            products               = products,
            criteria_text          = criteria_text,
            scope                  = scope_arg,
            quick_filter           = quick_filter,
            include_closed_stories = include_closed_stories,
        )

        # `is_initial_page` toggles which fixed-state fields we ship.
        # First page (= no cursor) carries the full SPA bootstrap;
        # subsequent pages carry just stories+singletons+next_cursor.
        is_initial_page = not cursor

        stories, singletons, stats = load_watch(
            conn, user["id"], user["profile"], monitor_ids, window_hours,
            query_state=query_state,
        )

        # User-state (saved/ignored/unread) is only meaningful — and only
        # enabled in the UI — on your own watch. Non-owners get the buttons
        # rendered as disabled placeholders ("feature teasing"), driven by
        # the absence of `user_state`.
        views: list[dict] | None    = [] if is_initial_page else None
        folders: list[dict] | None  = [] if is_initial_page else None
        universe: dict | None       = None
        if is_owner:
            # User-state mutation runs on the FULL universe so that
            # downstream aggs and the next-page cursor walk see consistent
            # user_state on every item.
            attach_user_actions_state(conn, user["id"], stories, singletons)
            attach_folder_membership(conn, user["id"], stories, singletons)

            # Initial-page-only payload: SPA bootstrap state that doesn't
            # change across pages of the same /watch session.
            if is_initial_page:
                views    = load_user_views(conn, user["id"])
                folders  = load_user_folders(conn, user["id"])
                universe = load_user_universe(user["monitors"])

        # Sidebar aggregations. Computed on
        # the FULL universe — pagination doesn't shrink the aggs the
        # sidebar shows. We only emit them on the first page; the SPA
        # caches the payload and the counts are stable across page
        # fetches of the same /watch session.
        aggs_server = compute_aggregations(stories, singletons) if is_initial_page else None

        # ── Pagination ────────────────────────────────────────────────
        # Slice the unified recency-sorted stream. `paginate_stream`
        # respects the SPA's tab labels via `item_type` and emits the
        # `next_cursor` for the page tail (None when exhausted).
        # The recency helpers are the same callables load_watch sorted
        # the lists with — keeps the cursor ordering contract truly
        # identical to the sort that produced the input lists.

        stories, singletons, next_cursor = paginate_stream(
            stories=stories,
            singletons=singletons,
            cursor=cursor,
            limit=limit,
            item_type=item_type,
            story_recency_fn=cluster_recency_max,
            singleton_recency_fn=pub_sort_key,
        )

        # Read-state hydration is sized to the PAGE, not the universe —
        # the SPA accumulates IDs across pages into a single Set, so
        # each page only needs to ship state for its own articles.
        read_article_ids: list[int] = []
        if is_owner:
            visible_ids: list[int] = []
            for s in stories:
                visible_ids.extend(a["id"] for a in s.get("articles", []))
            visible_ids.extend(a["id"] for a in singletons)
            read_article_ids = load_read_article_ids(conn, user["id"], visible_ids)

        # ── Conditionally embed aggregations — CACHE-ONLY embed ──────
        # Computing the 14-facet aggregations
        # on a 30k-article universe takes 5-25s server-side — too slow
        # to block /watch on. Instead we only embed when the aggregations
        # cache ALREADY has the answer for this exact (user, filter,
        # scope, lang) combo. The trade-off:
        #
        # - First /watch of a session (cache cold) → embed=null, /watch
        #   returns in 5-7s, the SPA fires its async useWatchAggs hook
        #   and paints counts ~10-20s later.
        # - Subsequent /watch reloads / navigations within 60s → cache
        #   hit, embed populated, /watch stays fast AND ships correct
        #   counters in the same response (SPA skips the async fetch).
        #
        # No compute happens here on a cache miss — that work belongs to
        # the dedicated /watch/aggregations endpoint, where the SPA can
        # render the page first and tolerate the latency.
        watch_aggs: dict | None = None
        if is_initial_page and is_owner:
            try:
                from src.watch_aggregations import _cache_get, _cache_key
                cache_key = _cache_key(
                    query_state,
                    user["id"],
                    tuple(monitor_ids),
                    (user["profile"].get("structured", {})
                                    .get("output_preference", {})
                                    .get("lang") or "fr").lower(),
                )
                watch_aggs = _cache_get(cache_key)  # None on miss; no compute
            except Exception as e:
                print(f"[/watch] aggregations cache lookup failed: {e}", flush=True)
                watch_aggs = None
    finally:
        conn.close()

    # Authed responses can carry owner-specific data; never let a shared
    # CDN cache them across users. Anon responses stay CDN-cacheable.
    response.headers["Cache-Control"] = (
        DATA_CACHE_PRIVATE if auth is not None else DATA_CACHE_CONTROL
    )
    response.headers["Vary"] = "Authorization, Accept-Encoding"

    return {
        "user":             user["profile"].get("name", slug),
        "slug":             slug,
        "window_hours":     window_hours,
        "stats":            stats,
        "stories":          stories,
        "singletons":       singletons,
        "viewer": {
            "is_authenticated": auth is not None,
            "is_owner":         is_owner,
        },
        # Owner-only; empty array for anon viewers. Drives the per-article
        # blue-dot "still new" indicator on the SPA — articles whose IDs
        # appear here render without a dot. Ships per-PAGE: the SPA
        # accumulates ids across pages into a single Set.
        "read_article_ids": read_article_ids,
        # ── Pagination contract ────────────────────────────────────────
        # `next_cursor` is the opaque token to fetch the next page; null
        # when this page exhausts the stream. `is_initial_page` lets the
        # SPA distinguish "fresh /watch load" (replace state) from
        # "append next page" (extend accumulated stories).
        "next_cursor":      next_cursor,
        "is_initial_page":  is_initial_page,
        # ── Fixed state — initial-page only ────────────────────────────
        # On subsequent pages (`cursor` provided), these fields are null /
        # empty. The SPA keeps them from the first-page response of the
        # current /watch session.
        # Owner-only; user's saved views (smart-filter sets). Empty for
        # anon viewers / non-initial pages. The SPA renders these under
        # the "Mes vues" section in the Watch sidebar.
        "views":   views,
        # Owner-only; user's manual folders + story_count for each. Empty
        # for anon viewers / non-initial pages. Each story.user_state.
        # folder_ids points back into this list for the picker.
        "folders": folders,
        # Owner-only; full universe of filterable values (independent of
        # current articles). Drives the view definition UI so users can
        # pick languages/countries/categories/feeds that may not have any
        # article in the current watch but could match later. Null on
        # non-initial pages — already in the SPA from first page.
        "universe": universe,
        # Owner-only; persistent default `Advanced`-shaped filter
        # preferences. The SPA seeds its `advanced` state from this on
        # mount so the user's defaults apply automatically. Empty
        # default for anon viewers and non-initial pages.
        "preferences": (
            preferences if (is_owner and is_initial_page) else _empty_preferences()
        ),
        # Sidebar aggregations precomputed server-side.
        # Computed over the FULL universe (= the user's whole window),
        # NOT the paginated page — so sidebar counts stay correct
        # regardless of how many pages the SPA has loaded. Null on
        # non-initial pages (the SPA keeps the first-page payload).
        "aggs_server": aggs_server,
        # Aggregations matching the /watch/aggregations endpoint.
        # When present, the SPA's `useWatchAggs`
        # hook seeds from this instead of firing a separate request —
        # tab counts and sidebar counters are correct from the very first
        # paint. Null on non-initial pages and for anon viewers.
        "watch_aggs": watch_aggs,
    }


@router.get("/users/{slug}/watch/aggregations")
def get_user_watch_aggregations(
    response: Response,
    slug: str,
    auth: AuthContext | None = Depends(get_optional_auth),
    # Mirror the /watch query-param surface so the SPA passes the same
    # bag of params. We do NOT support `cursor` / `limit` / `item_type`
    # — aggregations are always over the FULL universe, the SPA reads
    # them straight into the sidebar regardless of page position.
    window_hours: int = Query(24, ge=WINDOW_HOURS_MIN, le=WINDOW_HOURS_MAX),
    period_hours: int | None = Query(None, ge=MIN_PERIOD_HOURS, le=MAX_PERIOD_HOURS),
    q:                      str       | None = Query(None),
    keywords:               list[str] | None = Query(None),
    excluded_keywords:      list[str] | None = Query(None),
    categories:             list[str] | None = Query(None),
    excluded_categories:    list[str] | None = Query(None),
    article_types:          list[str] | None = Query(None),
    excluded_article_types: list[str] | None = Query(None),
    langs:                  list[str] | None = Query(None),
    feeds:                  list[str] | None = Query(None),
    source_countries:       list[str] | None = Query(None),
    subject_countries:      list[str] | None = Query(None),
    # Entity filters: integer entity_id from `entities.id`.
    persons:                list[int] | None = Query(None),
    orgs:                   list[int] | None = Query(None),
    locations:              list[int] | None = Query(None),
    events:                 list[int] | None = Query(None),
    markets:                list[int] | None = Query(None),
    products:               list[int] | None = Query(None),
    criteria_text: str | None = Query(None, description=(
        "Lucene-syntax Boolean filter. Mirrors /watch's param."
    )),
    include_closed_stories: bool             = Query(False),
    quick_filter: str = Query(
        "all", regex="^(all|unread|saved|ignored)$",
        description="Mirror of /watch's quick_filter. Used for the saved "
                    "QueryState shape only; the counts themselves expose "
                    "ALL four buckets regardless of which is active.",
    ),
) -> dict:
    """Sidebar counts for the current Watch query.

    Returns a dict with:
      - `total_count`: int — total visible items (= stories + singletons)
      - `by_scope`: {"all": n, "common": n, "original": n}
      - `by_quick_filter`: {"all": n, "unread": n, "saved": n, "ignored": n}
      - `by_<facet>`: list of {value, count}, sorted by count DESC, capped
        at TOP_N_PER_FACET. Sibling `by_<facet>_has_more: bool` signals
        truncation.

    Visibility gate identical to /watch: public users open to anon,
    private users only to their owner.
    """
    conn = get_connection()
    try:
        user = _load_user(conn, slug)

        is_owner = False
        if auth is not None:
            viewer_user_id = resolve_user_id(conn, auth)
            is_owner = viewer_user_id == user["id"]

        if not user["is_public"] and not is_owner:
            if auth is None:
                raise HTTPException(status_code=401,
                                    detail="Authentication required to view this watch")
            raise HTTPException(status_code=403, detail="This watch is private")

        monitor_ids = [m["id"] for m in user["monitors"]]

        # Owner preferences override period when periodMinutes is set —
        # same precedence as /watch.
        if is_owner:
            cur = conn.cursor()
            cur.execute("SELECT preferences FROM users WHERE id = %s", (user["id"],))
            pref_row = cur.fetchone()
            if pref_row and pref_row[0]:
                raw = (pref_row[0] if isinstance(pref_row[0], dict)
                       else json.loads(pref_row[0]))
                preferences = _normalize_preferences(raw)
                pref_minutes = int(preferences.get("periodMinutes") or 0)
                if pref_minutes > 0:
                    derived_hours = max(
                        WINDOW_HOURS_MIN,
                        min(WINDOW_HOURS_MAX, (pref_minutes + 59) // 60),
                    )
                    window_hours = derived_hours

        effective_period_hours = (
            period_hours if period_hours is not None else window_hours
        )

        output_lang = (
            user["profile"].get("structured", {})
                            .get("output_preference", {})
                            .get("lang") or "fr"
        ).lower()

        query_state = build_watch_query_state(
            period_hours           = effective_period_hours,
            q                      = q,
            keywords               = keywords,
            excluded_keywords      = excluded_keywords,
            categories             = categories,
            excluded_categories    = excluded_categories,
            article_types          = article_types,
            excluded_article_types = excluded_article_types,
            langs                  = langs,
            feeds                  = feeds,
            source_countries       = source_countries,
            subject_countries      = subject_countries,
            persons                = persons,
            orgs                   = orgs,
            locations              = locations,
            events                 = events,
            markets                = markets,
            products               = products,
            criteria_text          = criteria_text,
            scope                  = "all",          # aggregations cover all scopes
            quick_filter           = quick_filter,
            include_closed_stories = include_closed_stories,
        )

        aggregations = compute_watch_aggregations(
            conn,
            qs                = query_state,
            user_id           = user["id"] if is_owner else None,
            scope_monitor_ids = monitor_ids,
            output_lang       = output_lang,
        )
    finally:
        conn.close()

    response.headers["Cache-Control"] = (
        DATA_CACHE_PRIVATE if auth is not None else DATA_CACHE_CONTROL
    )
    response.headers["Vary"] = "Authorization, Accept-Encoding"

    return aggregations


@router.get("/worker/last-pass-ts")
def get_worker_last_pass_ts(response: Response) -> dict:
    """
    Timestamp of the worker's most recent successful fetch. Catch-up endpoint
    the SPA polls when its `worker:heartbeat` broadcast subscription
    may have missed events (backgrounded tab, throttled WebSocket).

    Source: `MAX(monitors.last_success_at)`, which every successful
    fetch sets, so it tracks the worker's last pass within a few
    seconds. Cheap query — a few hundred rows.

    Public (no auth). The value is non-sensitive and identical for all
    viewers, so a short CDN cache amortizes the read across users.
    """
    response.headers["Cache-Control"] = "public, max-age=10"
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT MAX(last_success_at) FROM monitors")
        (ts,) = cur.fetchone()
    finally:
        conn.close()
    return {"ts": ts.isoformat() if ts else None}


@router.get("/users/{slug}/new-articles-count")
def get_user_new_articles_count(
    slug: str,
    response: Response,
    since: str = Query(..., description="ISO 8601 timestamp"),
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Count items ingested after `since` that fall in this user's
    monitors. Catch-up query the SPA fires when the Realtime broadcast
    channel may have missed events (tab sleep, WebSocket throttling,
    connection drops). Broadcasts are at-most-once and ephemeral on
    Supabase Realtime, so anything emitted while the client's socket is
    suspended is lost — this endpoint gives the SPA an authoritative
    count from the DB to reconcile against.

    Same query shape as `_notify_users_of_new_articles` in runner.py.
    Cheap: bounded by the `items.fetched_at` index, scoped to the
    user's monitors.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        user = _load_user(conn, slug)
        if user["id"] != viewer_user_id:
            # Same opaque 404 as the watch endpoint — never confirm a
            # user's existence to a non-owner.
            raise HTTPException(status_code=404, detail=f"User {slug!r} not found")

        monitor_ids = [m["id"] for m in user["monitors"]]
        if not monitor_ids:
            return {"count": 0}

        cur = conn.cursor()
        cur.execute(
            """
            SELECT COUNT(DISTINCT a.id)
              FROM items a
              JOIN monitor_items mi ON mi.item_id = a.id
             WHERE a.fetched_at >= %s
               AND mi.monitor_id = ANY(%s)
               AND a.archive_seed       = FALSE
               AND a.title_normalized IS NOT NULL
               AND TRIM(a.title_normalized) <> ''
            """,
            (since, monitor_ids),
        )
        (count,) = cur.fetchone()
    finally:
        conn.close()

    return {"count": int(count)}
