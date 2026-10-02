"""
Per-user routes: everything under `/me`.

Preferences, notifications, saved views, folders and the library. All of it is scoped to the caller — there is no route here
that reads or writes anybody else's data, which is why every handler
takes `get_required_auth` rather than the optional variant.
"""
from __future__ import annotations

import json

import psycopg2.errors
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from src.admin.auth import _is_admin_email
from src.auth import AuthContext, get_required_auth, resolve_user_id
from src.db import get_connection
from src.loaders.account import (
    load_user_folders,
    load_user_universe,
    load_user_views,
    normalize_advanced_criteria,
)
from src.loaders.library import load_folder_data, load_saved_stories
from src.loaders.stories import attach_folder_membership, attach_user_actions_state
from src.monitors import get_user_monitor_ids, get_user_monitors
from src.notifications import normalize_notif_prefs
from src.routes._shared import (
    DATA_CACHE_PRIVATE,
    _ensure_story_exists,
    _normalize_preferences,
)
from src.watch_aggregations import compute_views_counts, invalidate_views_counts_cache
from src.write_access import has_write_access

router = APIRouter(prefix="/me", tags=["me"])


@router.get("")
def get_me(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Resolve the bearer JWT to the user's identity.

    Used right after login by the SPA to figure out which slug to redirect
    to AND which UI locale to set (the cookie is then sourced from
    `output_lang` so the UI matches the pre-translated content). Lazy-
    links auth_id to public.users on first call (matched by email).
    Returns 404 if no public.users row matches — for now that means we
    haven't pre-provisioned the user yet.
    """
    response.headers["Cache-Control"] = "private, no-store"

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(
                status_code=404,
                detail="No watch is linked to this account yet",
            )
        cur = conn.cursor()
        cur.execute(
            "SELECT slug, name, output_lang FROM users WHERE id = %s AND active = TRUE",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User row missing")
        # What the interface may offer. Deliberately the DECISION rather than
        # the plan behind it: the question a screen asks is "may this person
        # save?", never "which tier are they on". Returning the answer keeps
        # the admin bypass included for free, survives a third plan being
        # added, and makes it impossible for the frontend's idea of the rule
        # to drift from the middleware's — both call the same function.
        can_write = _is_admin_email(auth.email) or has_write_access(
            conn, viewer_user_id
        )
    finally:
        conn.close()

    output_lang = (row[2] or "en").lower()

    return {
        "slug":         row[0],
        "name":         row[1],
        "output_lang":  output_lang,
        "can_write":    can_write,
    }


@router.get("/preferences")
def get_preferences(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Returns the caller's persistent preferences (or the empty
    default if never set). Used by the Settings page to seed the form."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "SELECT preferences FROM users WHERE id = %s",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User row missing")
        raw = row[0]
        prefs = raw if isinstance(raw, dict) else json.loads(raw or "{}")
        return _normalize_preferences(prefs)
    finally:
        conn.close()


class _BooleanCompileBody(BaseModel):
    model_config = {"extra": "forbid"}
    text: str


@router.post("/query/compile")
def post_me_query_compile(
    body: _BooleanCompileBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Parse a Lucene-syntax query and return the structural feedback
    the SPA needs to render error highlights + a debug-friendly view.

    Returns:
      - `ok`: True iff the parse succeeded
      - `error`: human-readable message when ok=False
      - `sql_preview`: the compiled WHERE fragment (with `?` placeholders
                        in lieu of params, for transparency / debug)
      - `param_count`: how many params the WHERE fragment expects
    """
    from src.boolean_query import (
        BooleanQueryError,
        compile_to_where,
    )
    from src.boolean_query import (
        parse as parse_boolean,
    )
    try:
        tree = parse_boolean(body.text)
    except BooleanQueryError as e:
        return {"ok": False, "error": str(e), "sql_preview": None, "param_count": 0}

    sql, params = compile_to_where(tree, alias="a")
    # Render `?` placeholders in place of psycopg %s for cleaner UI display.
    preview = sql.replace("%s", "?")
    return {
        "ok":           True,
        "error":        None,
        "sql_preview":  preview,
        "param_count":  len(params),
    }


class _BooleanTestBody(BaseModel):
    # `extra: "ignore"` so a frontend sending a legacy `period_hours`
    # field (from before 2026-07) doesn't 422. Period is fixed
    # server-side to the retention cap now.
    model_config = {"extra": "ignore"}
    text:  str
    limit: int = 10


@router.post("/query/test")
def post_me_query_test(
    body: _BooleanTestBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Run a compiled Boolean query against the caller's universe of
    articles + return a small preview + total count.

    The preview is intentionally narrow (10 articles by default, capped
    at 50) — this endpoint is for "do my filters look right?", not for
    paginated browsing. The actual /watch endpoint is what serves
    full result sets.

    Scope identical to /watch's `load_visible_articles` — the caller's
    feeds — so the test universe matches what a saved view would see.
    """
    from datetime import datetime, timedelta, timezone

    from src.boolean_query import (
        BooleanQueryError,
        compile_to_where,
    )
    from src.boolean_query import (
        parse as parse_boolean,
    )

    try:
        tree = parse_boolean(body.text)
    except BooleanQueryError as e:
        return {"ok": False, "error": str(e),
                "count": 0, "sample": []}

    sql, params = compile_to_where(tree, alias="a")
    limit = max(1, min(int(body.limit or 10), 50))
    # The query editor preview always runs on the widest window the
    # user could see (= DB retention cap). That way "0 matches" here
    # unambiguously means "the query is wrong / too narrow", not "the
    # SPA period is too short".
    from src.retention import RETENTION_MAX_HOURS
    cutoff = datetime.now(timezone.utc) - timedelta(hours=RETENTION_MAX_HOURS)

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        scope_monitor_ids = get_user_monitor_ids(conn, viewer_user_id)
        if not scope_monitor_ids:
            return {"ok": True, "error": None, "count": 0, "sample": []}

        # COUNT + sample, both filtered to the user's feed scope + the
        # period window. Free-text matching happens via the compiled
        # WHERE fragment; everything else is the standard /watch
        # filtering.
        common_sql = f"""
            FROM items a
            LEFT JOIN sources s ON s.id = a.source_id
            WHERE ({sql})
              AND a.archive_seed = FALSE
              AND a.title_normalized IS NOT NULL
              AND TRIM(a.title_normalized) <> ''
              AND COALESCE(a.published_at, a.fetched_at) >= %s
              AND EXISTS (
                  SELECT 1 FROM monitor_items mi
                   WHERE mi.item_id = a.id AND mi.monitor_id = ANY(%s)
              )
        """
        count_sql = "SELECT COUNT(*) " + common_sql
        sample_sql = (
            "SELECT a.id, a.title_normalized, a.title, "
            "       COALESCE(a.published_at, a.fetched_at) AS published_at, "
            "       (SELECT mo.name FROM monitor_items mi "
            "          JOIN monitors mo ON mo.id = mi.monitor_id "
            "         WHERE mi.item_id = a.id "
            "         ORDER BY mi.fetched_at LIMIT 1) AS feed_name, "
            "       a.lang " +
            common_sql +
            " ORDER BY published_at DESC LIMIT %s"
        )
        full_params = params + [cutoff, scope_monitor_ids]
        cur.execute(count_sql, full_params)
        count = int(cur.fetchone()[0])

        cur.execute(sample_sql, full_params + [limit])
        sample = [
            {
                "id":           r[0],
                "title":        r[1] or r[2] or "",
                "published_at": r[3].isoformat() if r[3] else None,
                "feed":         r[4],
                "lang":         r[5],
            }
            for r in cur.fetchall()
        ]
    finally:
        conn.close()

    return {"ok": True, "error": None, "count": count, "sample": sample}


@router.get("/entities/search")
def get_me_entities_search(
    response: Response,
    q:    str = Query("", description="Substring or prefix to search for in canonical_label."),
    kind: str | None = Query(None, description="Restrict to one kind (person/org/location/event/market/product)."),
    limit: int = Query(10, ge=1, le=50),
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Typeahead-search the `entities` table for the Boolean editor's
    @-mention autocomplete.

    Returns rows shaped for direct consumption by the editor:
      `{entity_id, qid, name, kind, country, image_url, description,
        n_articles}` ordered by trigram similarity to the query DESC,
      then by `canonical_label` ASC.

    `n_articles` is a coarse popularity hint (= count of distinct
    item_entities rows referencing this entity, capped/sampled
    so the lookup stays cheap). It lets the editor sort "more useful"
    entities to the top when the user starts typing.

    Anyone authenticated can search — entity metadata is global,
    not scoped to the user's feed universe. The search hits the
    trgm GIN index on `canonical_label` so it stays fast even on
    the full 7500-row table.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    query = (q or "").strip()
    if not query:
        return {"results": []}

    valid_kinds = {"person", "org", "location", "event", "market", "product"}
    kind_filter_sql = ""
    kind_param: list = []
    if kind in valid_kinds:
        kind_filter_sql = " AND e.kind = %s"
        kind_param.append(kind)

    conn = get_connection()
    try:
        cur = conn.cursor()
        # Trigram similarity ranks "Macron" higher than "Macaronic" for
        # query "Macron". `%` operator is the trigram membership test;
        # similarity() returns the actual ranking score.
        cur.execute(
            f"""
            SELECT e.id, e.wikidata_id, e.canonical_label, e.kind,
                   e.country, e.image_url, e.description,
                   (SELECT COUNT(*) FROM item_entities ae
                     WHERE ae.entity_id = e.id) AS n_articles
              FROM entities e
             WHERE e.status = 'active'
               AND e.canonical_label %% %s
               {kind_filter_sql}
             ORDER BY similarity(e.canonical_label, %s) DESC,
                      e.canonical_label ASC
             LIMIT %s
            """,
            [query] + kind_param + [query, int(limit)],
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    return {
        "results": [
            {
                "entity_id":   int(r[0]),
                "qid":         r[1],
                "name":        r[2],
                "kind":        r[3],
                "country":     r[4],
                "image_url":   r[5],
                "description": r[6],
                "n_articles":  int(r[7] or 0),
            }
            for r in rows
        ],
    }


@router.get("/views/counts")
def get_me_views_counts(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
    period_hours: int | None = Query(
        None,
        description=(
            "Time window (in hours) for the per-view count. Clipped to "
            "[1, RETENTION_MAX_HOURS]. Defaults to SPA_PERIOD_DEFAULT_H "
            "(24h) — matches the frontend period selector's default."
        ),
        ge=1,
    ),
) -> dict:
    """Return `{view_id: count}` for each of the caller's saved views.

    Each count = the number of visible items (= stories + singletons)
    in the user's scope that would match the view's criteria. The same
    aggregations machinery that powers /watch/aggregations is used here,
    so the counts agree with what the user sees in the list when they
    click that view.

    Owner-only (= the authed user is the owner by definition). The SPA
    sidebar's "Mes vues" rows consume this via the `useViewCounts` hook
    to surface a badge next to each view name ("Ukraine 12").

    Performance: one wide temp-table build (~30s on big users, cached
    60s afterward) followed by N small COUNT queries (~50ms each). The
    hook fires asynchronously after /watch returns — never blocks the
    initial paint. View CRUD invalidates the cache via
    `invalidate_views_counts_cache(user_id)`.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        # Pull the user's slug + profile (= for output_lang) and feeds —
        # the same scope as /watch.
        cur = conn.cursor()
        cur.execute(
            "SELECT slug, profile FROM users WHERE id = %s AND active = TRUE",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User row missing")
        profile_raw = row[1]
        profile = profile_raw if isinstance(profile_raw, dict) else json.loads(profile_raw or "{}")
        output_lang = (
            profile.get("structured", {})
                   .get("output_preference", {})
                   .get("lang") or "fr"
        ).lower()

        scope_monitor_ids = get_user_monitor_ids(conn, viewer_user_id)

        # `load_user_views` already returns views shaped as
        # {id, name, criteria, ...}. We pass them straight to the
        # aggregations helper which only reads `id` + `criteria`.
        views = load_user_views(conn, viewer_user_id)

        # Clip period_hours to the SPA's contract with the DB retention
        # cap. The UI dropdown already refuses values > cap, but a
        # hand-crafted request could still ask for e.g. 10000 — silently
        # clip rather than 400 so the counter renders something useful.
        from src.retention import (
            RETENTION_MAX_HOURS,
            SPA_PERIOD_DEFAULT_H,
        )
        effective_period_hours = min(
            max(period_hours or SPA_PERIOD_DEFAULT_H, 1),
            RETENTION_MAX_HOURS,
        )

        counts = compute_views_counts(
            conn,
            user_id           = str(viewer_user_id),
            scope_monitor_ids = scope_monitor_ids,
            output_lang       = output_lang,
            views             = views,
            period_hours      = effective_period_hours,
        )
    finally:
        conn.close()

    return {
        "counts":       counts,
        "period_hours": effective_period_hours,
    }


class PreferencesPayload(BaseModel):
    """Loose schema — the actual shape is validated/normalized by
    `_normalize_preferences`. Pydantic is just here to deserialize JSON
    body into a dict; we don't enforce a strict shape because the
    frontend may ship new optional fields ahead of a backend update."""
    model_config = {"extra": "allow"}


@router.put("/preferences")
def put_preferences(
    payload: PreferencesPayload,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Replaces the caller's preferences. The full shape is written
    each call (no PATCH semantics) — the Settings form submits the
    complete state, so partial updates would be wasted complexity."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        normalized = _normalize_preferences(payload.model_dump())
        cur = conn.cursor()
        cur.execute(
            "UPDATE users SET preferences = %s, updated_at = NOW() WHERE id = %s",
            (json.dumps(normalized), viewer_user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return normalized


NOTIFICATIONS_PAGE_LIMIT = 50


NOTIFICATIONS_PAGE_LIMIT_MAX = 200


@router.get("/notifications")
def get_me_notifications(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
    limit: int = Query(NOTIFICATIONS_PAGE_LIMIT, ge=1, le=NOTIFICATIONS_PAGE_LIMIT_MAX),
    before_id: int | None = Query(
        None,
        description="Cursor — return rows with id < before_id (older than)",
    ),
) -> dict:
    """Paginated inbox view.

    Default sort: recency DESC (most recent first). `before_id` is the
    classic forward-only cursor — when null, returns the newest `limit`
    rows; subsequent pages pass the smallest id from the previous page.

    Always returns the unread count as well, so the bell badge stays in
    sync without an extra round-trip.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        if before_id is None:
            cur.execute(
                """
                SELECT id, type, payload, created_at, read_at
                  FROM notifications
                 WHERE user_id = %s
                 ORDER BY id DESC
                 LIMIT %s
                """,
                (viewer_user_id, limit),
            )
        else:
            cur.execute(
                """
                SELECT id, type, payload, created_at, read_at
                  FROM notifications
                 WHERE user_id = %s
                   AND id < %s
                 ORDER BY id DESC
                 LIMIT %s
                """,
                (viewer_user_id, before_id, limit),
            )
        rows = cur.fetchall()
        notifications = [
            {
                "id":         row[0],
                "type":       row[1],
                "payload":    row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}"),
                "created_at": row[3].isoformat() if row[3] else None,
                "read_at":    row[4].isoformat() if row[4] else None,
            }
            for row in rows
        ]

        # Notifications are dismiss-on-handle (DELETE on click / clear-all),
        # so every row in the inbox is by definition pending — the count is
        # just `COUNT(*)`. The field name stays `unread_count` for SPA
        # compat; semantically it now means "items left to deal with".
        cur.execute(
            "SELECT COUNT(*) FROM notifications WHERE user_id = %s",
            (viewer_user_id,),
        )
        (unread_count,) = cur.fetchone()

        return {
            "notifications":  notifications,
            "unread_count":   unread_count,
            "next_before_id": notifications[-1]["id"] if notifications else None,
        }
    finally:
        conn.close()


@router.delete("/notifications/{notif_id}")
def delete_me_notification(
    notif_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Dismiss a single notification.

    Fired by the SPA when the user clicks a row (deep-link + auto-clear,
    Gmail/Slack style — handling the notif removes it from the inbox).
    Idempotent: deleting an already-gone row is a no-op, returns 200.
    Returns 404 only if the id never belonged to the caller (or never
    existed), which is the meaningful error.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        cur.execute(
            "DELETE FROM notifications WHERE id = %s AND user_id = %s",
            (notif_id, viewer_user_id),
        )
        # rowcount=0 just means it was already gone — safe to treat as ok.
        conn.commit()
        return {"deleted": cur.rowcount}
    finally:
        conn.close()


@router.delete("/notifications")
def delete_me_notifications_all(
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Clear the caller's whole inbox.

    Powers the "Tout effacer" affordance in the bell popover. Deletes
    every notification belonging to the caller — irreversible from the
    user's side, which is why the SPA puts it behind a confirm step.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        cur.execute(
            "DELETE FROM notifications WHERE user_id = %s",
            (viewer_user_id,),
        )
        deleted = cur.rowcount
        conn.commit()
        return {"deleted": deleted}
    finally:
        conn.close()


@router.get("/notif-prefs")
def get_me_notif_prefs(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Return the caller's per-type channel preferences merged with the
    server-side defaults. The Settings → Notifications UI seeds its
    form from this — every group is guaranteed present with both flags."""
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        cur.execute(
            "SELECT notif_prefs FROM users WHERE id = %s",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        raw = row[0] if row else None
        prefs = raw if isinstance(raw, dict) else json.loads(raw or "{}")
        return normalize_notif_prefs(prefs)
    finally:
        conn.close()


class NotifPrefsPayload(BaseModel):
    """Loose shape — `normalize_notif_prefs` enforces the canonical
    structure, ignoring unknown keys and coercing flags to bool."""
    model_config = {"extra": "allow"}


@router.put("/notif-prefs")
def put_me_notif_prefs(
    payload: NotifPrefsPayload,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Replace the caller's notification channel preferences.

    Always writes the full canonical shape (= every known group with
    both flags resolved). Saves are cheap so we don't bother diffing
    against the current DB row."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        normalized = normalize_notif_prefs(payload.model_dump())
        cur = conn.cursor()
        cur.execute(
            "UPDATE users SET notif_prefs = %s, updated_at = NOW() WHERE id = %s",
            (json.dumps(normalized), viewer_user_id),
        )
        conn.commit()
        return normalized
    finally:
        conn.close()


@router.get("/saved")
def get_saved(
    response: Response,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Return every story the authenticated user has saved, sorted saved_at DESC.

    No time cutoff, no feed filter — once saved, a story stays in the user's
    library even if they later unsubscribe from the originating feed.

    Each story carries `saved_at` (ISO) plus the same shape the SPA renders
    in /watch (title, articles, sources, image, score, categories, user_state).

    Also returns `views` + `universe` (same shape as /watch) so the SPA
    can wire the Library's view selector and advanced filter dialog
    against the same data model as Watch.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        cur.execute(
            "SELECT slug, profile FROM users WHERE id = %s AND active = TRUE",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User row missing")
        profile_raw = row[1]
        profile = profile_raw if isinstance(profile_raw, dict) else json.loads(profile_raw or "{}")

        stories = load_saved_stories(conn, viewer_user_id, profile)
        # All stories here are saved by definition; still call the standard
        # state attacher so ignored / read flags are correct (user can unsave
        # AND unignore from this view).
        attach_user_actions_state(conn, viewer_user_id, stories, [])
        attach_folder_membership(conn, viewer_user_id, stories, [])

        views    = load_user_views(conn, viewer_user_id)
        folders  = load_user_folders(conn, viewer_user_id)
        universe = load_user_universe(get_user_monitors(conn, viewer_user_id))
    finally:
        conn.close()

    return {
        "stories":  stories,
        "total":    len(stories),
        "views":    views,
        "folders":  folders,
        "universe": universe,
    }


@router.get("/folders/{folder_id}")
def get_folder(
    response: Response,
    folder_id: str,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Return the full content of a manual folder for the standalone
    Dossiers mode.

    The caller must own the folder. A 404 covers "not found" and "not
    yours" indistinguishably, so a folder id reveals nothing about
    whether it exists.

    Unlike /watch, the response carries the full cluster timeline
    without a 24h cutoff — the folder is a permanent collection.
    """
    response.headers["Cache-Control"] = DATA_CACHE_PRIVATE

    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")

        cur = conn.cursor()
        cur.execute(
            "SELECT slug, profile FROM users WHERE id = %s AND active = TRUE",
            (viewer_user_id,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="User row missing")
        _slug, profile_raw = row[0], row[1]
        profile = (
            profile_raw if isinstance(profile_raw, dict)
            else json.loads(profile_raw or "{}")
        )

        data = load_folder_data(conn, viewer_user_id, folder_id, profile)
        if data is None:
            raise HTTPException(
                status_code=404,
                detail=f"Folder {folder_id} not found",
            )

        # Attach user-state + folder-membership on the stories so the
        # SPA can render Save / Ignore buttons + the picker checked-
        # state, same as /watch.
        attach_user_actions_state(conn, viewer_user_id, data["stories"], [])
        attach_folder_membership(conn, viewer_user_id, data["stories"], [])

        # The contextual sidebar lists every folder so the user can switch
        # between them without an extra round-trip. Same shape as /watch.
        all_folders = load_user_folders(conn, viewer_user_id)
    finally:
        conn.close()

    return {
        **data,
        "folders": all_folders,
    }


class ViewBody(BaseModel):
    """Body schema for POST /me/views — name + filter spec.

    Two filter shapes accepted (frontend picks which based on the
    mode the user is in):
      - `criteria` (legacy Advanced JSONB) — written by the Panel UI
      - `criteria_text` (Lucene Boolean string) —
        written by the Boolean textarea OR the future query agent

    Exactly one of the two should be non-empty per request. If both
    are present, `criteria_text` wins (= it's the new canonical
    format). If neither, the view has no filters (matches everything)."""
    name: str = Field(min_length=1, max_length=120)
    criteria:      dict | None = None
    criteria_text: str  | None = None


class ViewUpdateBody(BaseModel):
    """Body for PUT /me/views — same shape as the POST body: either
    `criteria` (legacy Panel mode) or `criteria_text` (Boolean mode,
    canonical going forward)."""
    name: str = Field(min_length=1, max_length=120)
    criteria:      dict | None = None
    criteria_text: str  | None = None


def _view_row_to_dict(row) -> dict:
    # RETURNING shape:
    #   id, name, criteria, criteria_text, created_at, updated_at
    raw_criteria = row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}")
    return {
        "id":            str(row[0]),
        "name":          row[1],
        "criteria":      normalize_advanced_criteria(raw_criteria),
        "criteria_text": row[3],
        "created_at":    row[4].isoformat() if row[4] else None,
        "updated_at":    row[5].isoformat() if row[5] else None,
    }


@router.post("/views", status_code=201)
def create_view(
    body: ViewBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Create a new saved view."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        # `criteria` (legacy Advanced JSONB) and `criteria_text` (new
        # Lucene Boolean string) coexist during the
        # transition. We accept either or both — both stored, the
        # reader prefers criteria_text when populated.
        criteria_json = json.dumps(body.criteria or {})
        cur.execute(
            """INSERT INTO views (user_id, name, criteria, criteria_text)
               VALUES (%s, %s, %s::jsonb, %s)
               RETURNING id, name, criteria, criteria_text, created_at,
                         updated_at""",
            (viewer_user_id, body.name.strip(),
             criteria_json, body.criteria_text),
        )
        row = cur.fetchone()
        conn.commit()
        # New view changes the views-counts payload — drop the user's
        # cache so the sidebar badge refresh on next poll.
        invalidate_views_counts_cache(viewer_user_id)

    finally:
        conn.close()

    return _view_row_to_dict(row)


@router.put("/views/{view_id}")
def update_view(
    view_id: str,
    body: ViewUpdateBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Rename and/or update the criteria of one of the caller's views.
    Someone else's view surfaces as 404, so its existence is not leaked."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            """UPDATE views
                  SET name = %s, criteria = %s::jsonb,
                      criteria_text = %s
                WHERE id = %s AND user_id = %s
            RETURNING id, name, criteria, criteria_text, created_at,
                      updated_at""",
            (body.name.strip(),
             json.dumps(body.criteria or {}),
             body.criteria_text,
             view_id,
             viewer_user_id),
        )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"View {view_id} not found")
        conn.commit()
        invalidate_views_counts_cache(viewer_user_id)
    finally:
        conn.close()

    return _view_row_to_dict(row)


@router.delete("/views/{view_id}")
def delete_view(
    view_id: str,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Delete one of the caller's views. Idempotent (no-op if missing)."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM views WHERE id = %s AND user_id = %s",
            (view_id, viewer_user_id),
        )
        conn.commit()
        invalidate_views_counts_cache(viewer_user_id)
    finally:
        conn.close()
    return {"ok": True}


class FolderBody(BaseModel):
    """Body for POST and PUT /me/folders — just the name."""
    name: str = Field(min_length=1, max_length=120)


@router.post("/folders", status_code=201)
def create_folder(
    body: FolderBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Create a new (empty) folder. 409 if the caller already has a folder
    with that name."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        try:
            cur.execute(
                """INSERT INTO folders (user_id, name)
                   VALUES (%s, %s)
                   RETURNING id, name, created_at, updated_at""",
                (viewer_user_id, body.name.strip()),
            )
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            raise HTTPException(
                status_code=409,
                detail=f"A folder named '{body.name.strip()}' already exists",
            )
        row = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {
        "id":          str(row[0]),
        "name":        row[1],
        "story_count": 0,
        "created_at":  row[2].isoformat() if row[2] else None,
        "updated_at":  row[3].isoformat() if row[3] else None,
    }


@router.put("/folders/{folder_id}")
def rename_folder(
    folder_id: str,
    body: FolderBody,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Rename one of the caller's folders. 404 if it isn't theirs; 409 if
    they already have a folder with the new name."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        try:
            cur.execute(
                """UPDATE folders
                      SET name = %s
                    WHERE id = %s AND user_id = %s
                RETURNING id, name, created_at, updated_at""",
                (body.name.strip(), folder_id, viewer_user_id),
            )
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            raise HTTPException(
                status_code=409,
                detail=f"A folder named '{body.name.strip()}' already exists",
            )
        row = cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")
        # Story count for the response (so the frontend doesn't have to refetch
        # just to update the sidebar badge).
        cur.execute(
            "SELECT COUNT(*) FROM folder_stories WHERE folder_id = %s",
            (folder_id,),
        )
        story_count = int((cur.fetchone() or [0])[0])
        conn.commit()
    finally:
        conn.close()

    return {
        "id":          str(row[0]),
        "name":        row[1],
        "story_count": story_count,
        "created_at":  row[2].isoformat() if row[2] else None,
        "updated_at":  row[3].isoformat() if row[3] else None,
    }


@router.delete("/folders/{folder_id}")
def delete_folder(
    folder_id: str,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Delete one of the caller's folders. Cascades `folder_stories` via
    DB FK, so the stories themselves stay saved — only the folder is
    removed. Idempotent (no-op if missing or not theirs)."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM folders WHERE id = %s AND user_id = %s",
            (folder_id, viewer_user_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/folders/{folder_id}/stories/{story_id}", status_code=201)
def add_story_to_folder(
    folder_id: str,
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Add a story to a folder. Idempotent (composite PK + ON CONFLICT).

    Does not save the story: Save and Folder are independent axes
    (Gmail / Feedly model). Cleanup protection
    for folder-only stories is handled at the pg_cron level — see the
    `cleanup-old-data` cron job which protects any story still
    referenced from `folder_stories`.

    The caller must own the folder; 404 otherwise, so existence is not
    leaked.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM folders WHERE id = %s AND user_id = %s",
            (folder_id, viewer_user_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")

        _ensure_story_exists(conn, story_id)
        cur.execute(
            """INSERT INTO folder_stories (folder_id, story_id)
               VALUES (%s, %s)
               ON CONFLICT DO NOTHING""",
            (folder_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/folders/{folder_id}/stories/{story_id}")
def remove_story_from_folder(
    folder_id: str,
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Remove a story from a folder. Idempotent. Does NOT unsave — the story
    can sit in zero folders and still be in the user's library bucket.
    Unsaving is the only path that cascades into folder_stories.

    Same rule as add_story_to_folder: the caller must own the folder.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM folders WHERE id = %s AND user_id = %s",
            (folder_id, viewer_user_id),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Folder {folder_id} not found")
        cur.execute(
            "DELETE FROM folder_stories WHERE folder_id = %s AND story_id = %s",
            (folder_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


class StoriesReadAllPayload(BaseModel):
    """Story IDs to mark read in one shot — the full set the caller has
    loaded in their Watch. The client sends the ids it sees so we mark
    exactly that ('fresh start' button), without re-deriving the feed selection
    server-side."""
    story_ids: list[int] = Field(default_factory=list)


@router.post("/stories/read-all")
def post_me_stories_read_all(
    payload: StoriesReadAllPayload,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Bulk-mark stories as read for the caller (read_at = NOW()).

    Powers the Watch "Mark all as read" button. Per-user only — it writes
    to user_story_reads for the caller, so the ids the client sends can't
    touch anyone else's state. Idempotent: re-marking an already-read
    story just refreshes read_at, which is the desired fresh-start
    behavior. Returns how many rows were marked.
    """
    story_ids = list(dict.fromkeys(payload.story_ids))
    if not story_ids:
        return {"marked": 0}
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        # One round-trip: unnest the id array and upsert. The JOIN drops
        # ids that no longer exist (e.g. cleaned-up stories) so a stale
        # client list can't trip the user_story_reads -> stories FK.
        cur.execute(
            """
            INSERT INTO user_story_reads (user_id, story_id, read_at)
            SELECT %s, s.id, NOW()
              FROM unnest(%s::bigint[]) AS sid
              JOIN stories s ON s.id = sid
            ON CONFLICT (user_id, story_id)
            DO UPDATE SET read_at = NOW()
            """,
            (viewer_user_id, story_ids),
        )
        marked = cur.rowcount
        conn.commit()
        return {"marked": marked}
    finally:
        conn.close()
