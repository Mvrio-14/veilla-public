"""
What a reader kept: their saved stories and the contents of a folder.
Unlike the Watch, no monitor filter and no time window — a kept story
shows every article it has.
"""
from __future__ import annotations

from src.loaders.common import (
    dedup_feeds,
    parse_category,
    parse_json_list,
    pub_sort_key,
    resolve_display_summary,
    resolve_display_title,
)
from src.loaders.stories import (
    enrich_for_render,
    load_story_origins,
    load_story_texts,
    load_story_updates,
)


def _load_clustered_articles(
    conn, story_ids: list[int], output_lang: str,
) -> list[dict]:
    """
    Load every article belonging to any of the given story_ids,
    deduplicated by canonical_url, with `feeds_list` pre-aggregated.

    Same article-row shape as `load_visible_articles` produces — the
    SPA contract on cluster articles is uniform. Used by both
    `load_saved_stories` (the Library) and `load_folder_data` (the
    standalone Dossiers mode), which both want "the full cluster for
    a given set of story IDs, no feed filter, no time cutoff".

    Why a CTE pipeline: the naive form has `feeds_list` as a correlated
    sub-SELECT in the projection. Postgres re-runs that subquery per
    returned row with a full Seq Scan on `articles` (filtered by
    canonical_url match). For 10 stories with a handful of articles
    each this was already taking 20+ seconds in the Library — same
    pathology that took `load_visible_articles` from 110s to 1s when
    we extracted feeds_list as a CTE earlier.

    The shape is intentionally aligned with `load_visible_articles` so
    the row-to-dict mapping below can be lifted into a future shared
    helper if we keep accumulating these paths.

    `output_lang` drives the per-user-lang JSONB extraction on
    `title_translations` / `summary_translations` — see the matching
    note in `load_visible_articles`.
    """
    if not story_ids:
        return []

    cur = conn.cursor()
    cur.execute(
        """
        WITH in_scope_articles AS (
            SELECT DISTINCT a.id,
                            COALESCE(a.canonical_url, a.url) AS canonical_key
              FROM items a
              JOIN story_items sa ON sa.item_id = a.id
             WHERE sa.story_id = ANY(%s)
               AND a.archive_seed       = FALSE
               AND a.title_normalized IS NOT NULL
               AND TRIM(a.title_normalized) <> ''
        ),
        canonical_feeds AS (
            SELECT COALESCE(a.canonical_url, a.url) AS canonical_key,
                   json_agg(json_build_object(
                     'id',      m.id,
                     'name',    m.name,
                     'country', c.country,
                     'url',     m.config ->> 'url',
                     'source',  src.name
                   ) ORDER BY m.name) AS feeds_list
              FROM items a
              JOIN in_scope_articles isa ON isa.id = a.id
              JOIN monitor_items mi      ON mi.item_id = a.id
              JOIN monitors      m       ON m.id       = mi.monitor_id
              LEFT JOIN catalog c  ON c.id       = m.catalog_id
              LEFT JOIN sources  src     ON src.id     = m.source_id
             GROUP BY COALESCE(a.canonical_url, a.url)
        ),
        first_monitor AS (
            -- The monitor that delivered each item first: what the
            -- `feed_name` / `feed_url` fields have always named.
            SELECT DISTINCT ON (mi.item_id)
                   mi.item_id, m.name, m.config ->> 'url' AS url
              FROM monitor_items mi
              JOIN monitors m ON m.id = mi.monitor_id
             WHERE mi.item_id IN (SELECT id FROM in_scope_articles)
             ORDER BY mi.item_id, mi.fetched_at, mi.monitor_id
        ),
        entities_per_article AS (
            -- Same N+1 -> batch CTE refactor as in load_visible_articles
            -- above. See the longer explanation there.
            SELECT ae.item_id,
                   jsonb_agg(jsonb_build_object(
                     'entity_id',    e.id,
                     'qid',          e.wikidata_id,
                     'name',         e.canonical_label,
                     'kind',         e.kind,
                     'country',      e.country,
                     'image_url',    e.image_url,
                     'description',  e.description,
                     'salience',     ae.salience,
                     'surface_form', ae.surface_form
                   ) ORDER BY ae.salience DESC NULLS LAST,
                              e.canonical_label ASC) AS entities_linked
              FROM item_entities ae
              JOIN entities         e ON e.id = ae.entity_id
             WHERE ae.item_id IN (SELECT id FROM in_scope_articles)
               AND e.status = 'active'
             GROUP BY ae.item_id
        )
        SELECT * FROM (
            SELECT DISTINCT ON (COALESCE(a.canonical_url, a.url))
                   a.id, fm.name AS feed_name, a.title, a.url, a.summary,
                   a.title_normalized, a.summary_normalized,
                   a.image_url, a.lang, a.category, a.countries,
                   -- Source attribution — see load_visible_articles.
                   s.country AS source_country,
                   COALESCE(a.published_at, a.fetched_at) AS published_at,
                   s.name AS source_name,
                   a.keywords,
                   -- Linked entities — sourced from the
                   -- entities_per_article CTE (batch aggregation, replaces
                   -- the previous N+1 correlated subquery).
                   COALESCE(epa.entities_linked, '[]'::jsonb)::text AS entities_linked,
                   s.domain AS source_domain,
                   fm.url AS feed_url,
                   a.article_type,
                   (a.title_translations ->> %s)   AS title_for_user_lang,
                   a.fetched_at,
                   sa.story_id,
                   (a.summary_translations ->> %s)        AS summary_for_user_lang,
                   cf.feeds_list,
                   a.author,
                   a.authors
              FROM items a
              JOIN in_scope_articles isa ON isa.id = a.id
              -- LEFT: a saved story keeps an item whose monitor is gone.
              LEFT JOIN first_monitor fm ON fm.item_id = a.id
              LEFT JOIN sources       s  ON s.id   = a.source_id
              JOIN story_items     sa ON sa.item_id = a.id
              LEFT JOIN canonical_feeds cf
                     ON cf.canonical_key = COALESCE(a.canonical_url, a.url)
              -- Batch-loaded entities (replaces legacy N+1 subquery).
              LEFT JOIN entities_per_article epa ON epa.item_id = a.id
             WHERE sa.story_id = ANY(%s)
          ORDER BY COALESCE(a.canonical_url, a.url),
                   COALESCE(a.published_at, a.fetched_at) DESC
        ) deduped
        ORDER BY published_at DESC
        """,
        (story_ids, output_lang, output_lang, story_ids),
    )
    rows = cur.fetchall()

    return [
        {
            "id":                    r[0],
            "source":                r[13] or r[1],
            "feed_name":             r[1],
            "title":                 r[2],
            "url":                   r[3],
            "summary":               r[4] or "",
            "title_normalized":      r[5] or r[2],
            "summary_normalized":    r[6] or "",
            "image_url":             r[7],
            "lang":                  r[8],
            "category":              (parse_category(r[9]) if r[9] else ["Other"]),
            "countries":             parse_json_list(r[10]),
            "source_country":        r[11],
            "published_at":          r[12],
            "keywords":              parse_json_list(r[14]),
            # Linked entities — list, not bucketed dict.
            "entities":              parse_json_list(r[15]),
            "source_url":            f"https://{r[16]}" if r[16] else "",
            "feed_url":              r[17] or "",
            "article_type":          r[18],
            "title_for_user_lang":   r[19],
            "fetched_at":            r[20],
            "story_id":              r[21],
            "summary_for_user_lang": r[22],
            "feeds":                 dedup_feeds(parse_json_list(r[23])),
            # RSS byline (raw) — see load_visible_articles for rationale.
            "author":                r[24],
            "authors":               parse_json_list(r[25]),
        }
        for r in rows
    ]


def load_saved_stories(
    conn, user_id: str, profile: dict,
) -> list[dict]:
    """
    Load every story this user has saved, sorted saved_at DESC.

    Unlike /watch, no feed filter and no time cutoff — once saved, a story
    is reachable here forever. Articles are loaded across all sources so the
    user sees the full cluster even if they later unsubscribed from a feed.

    Each returned cluster carries a `saved_at` ISO string.
    """
    pref        = profile.get("structured", {}).get("output_preference", {})
    output_lang = (pref.get("lang") or "fr").lower()

    cur = conn.cursor()
    cur.execute(
        """SELECT story_id, saved_at FROM user_story_saves
           WHERE user_id = %s
           ORDER BY saved_at DESC""",
        (user_id,),
    )
    saved_rows = cur.fetchall()
    if not saved_rows:
        return []

    saved_ids    = [r[0] for r in saved_rows]
    saved_at_map = {r[0]: r[1] for r in saved_rows}

    # Bulk-load articles for all saved stories via the shared CTE helper
    # (feeds_list pre-aggregated, no correlated subquery, no Seq Scan
    # per row). See `_load_clustered_articles` for the rationale.
    articles = _load_clustered_articles(conn, saved_ids, output_lang)

    for a in articles:
        title, t_translated = resolve_display_title(a, output_lang)
        summary, s_translated = resolve_display_summary(a, output_lang)
        # Override `title_normalized` and `summary_normalized` with the
        # resolved (possibly translated) values — that's what the SPA
        # reads for display via the `*_normalized || *` fallback.
        # IMPORTANT: leave `title` and `summary` UNTOUCHED so the SPA
        # can still expose the raw source-language title (e.g. Japanese
        # script) under a "show original" toggle in the detail panel.
        a["title_normalized"] = title
        a["title_is_translated"] = t_translated
        a["summary_normalized"] = summary
        a["summary_is_translated"] = s_translated

    by_story: dict[int, list[dict]] = {}
    for a in articles:
        sid = a["story_id"]
        if sid is None:
            continue
        by_story.setdefault(sid, []).append(a)

    story_texts = load_story_texts(conn, saved_ids, output_lang)

    # Story status drives the Library unsave-confirmation: closed stories
    # are destructive to unsave (the cleanup will purge them), active ones
    # still live in Watch and the user can re-save anytime.
    cur.execute(
        "SELECT id, status FROM stories WHERE id = ANY(%s)",
        (saved_ids,),
    )
    status_by_story = {row[0]: row[1] for row in cur.fetchall()}

    # Timeline rows (story_updates) + origin paragraphs, both resolved to
    # the user's output_lang via the JSONB translation caches.
    visible_article_ids = [a["id"] for a in articles if a.get("id") is not None]
    updates_by_story = load_story_updates(
        conn, saved_ids, visible_article_ids, output_lang,
    )
    origins_by_story = load_story_origins(conn, saved_ids, output_lang)

    out: list[dict] = []
    for sid in saved_ids:  # preserves saved_at DESC ordering
        sub = by_story.get(sid)
        if not sub:
            # Story exists in saves but has no readable articles anymore —
            # skip silently rather than render an empty card.
            continue
        sub_sorted = sorted(
            sub,
            key=pub_sort_key,
            reverse=True,
        )
        texts = story_texts.get(sid, {})
        cluster = enrich_for_render(
            sub_sorted, texts.get("label", ""), texts.get("synthesis"),
            display_origin=origins_by_story.get(sid),
            updates=updates_by_story.get(sid, []),
        )
        cluster["story_id"] = sid
        cluster["saved_at"] = saved_at_map[sid].isoformat() if saved_at_map[sid] else None
        cluster["status"]   = status_by_story.get(sid)
        out.append(cluster)

    return out


def load_folder_data(
    conn, user_id: str, folder_id: str, profile: dict,
) -> dict | None:
    """
    Load the full content of a manual folder for the standalone
    Dossiers mode.

    Returns None when the folder doesn't exist or isn't the caller's.
    The API layer surfaces that as a 404 rather than a 403, so a folder
    id reveals nothing about whether it exists.

    Behavior mirrors `load_saved_stories`: no feed filter, no time
    cutoff — the folder is a permanent collection, the user expects to
    find every story they filed there, however old.
    """
    pref        = profile.get("structured", {}).get("output_preference", {})
    output_lang = (pref.get("lang") or "fr").lower()

    cur = conn.cursor()

    # ─── 1. Resolve + access-check the folder ─────────────────────────
    cur.execute(
        """SELECT id::text, name, created_at, updated_at
             FROM folders
            WHERE id = %s AND user_id = %s""",
        (folder_id, user_id),
    )
    row = cur.fetchone()
    if not row:
        return None
    folder = {
        "id":         row[0],
        "name":       row[1],
        "created_at": row[2].isoformat() if row[2] else None,
        "updated_at": row[3].isoformat() if row[3] else None,
    }

    # ─── 2. Story IDs in this folder ─────────────────────────────────
    cur.execute(
        """SELECT story_id, added_at FROM folder_stories
            WHERE folder_id = %s
         ORDER BY added_at DESC""",
        (folder_id,),
    )
    folder_rows = cur.fetchall()
    story_ids   = [r[0] for r in folder_rows]
    added_at    = {r[0]: r[1] for r in folder_rows}

    if not story_ids:
        return {
            "folder":      folder,
            "stories":     [],
            "singletons": [],
            "stats":       {"n_stories": 0, "n_singletons": 0, "n_articles": 0},
        }

    # ─── 3. Load every article across these stories ──────────────────
    # Shared CTE helper (feeds_list pre-aggregated, no per-row
    # correlated subquery). Same path as Library and Watch. No cutoff,
    # no feed filter — the folder is a permanent collection.
    articles = _load_clustered_articles(conn, story_ids, output_lang)

    # ─── 4. Resolve per-article display strings (title/summary i18n) ─
    for a in articles:
        title, t_translated     = resolve_display_title(a, output_lang)
        summary, s_translated   = resolve_display_summary(a, output_lang)
        a["title_normalized"]   = title
        a["title_is_translated"]= t_translated
        a["summary_normalized"] = summary
        a["summary_is_translated"]= s_translated

    # ─── 5. Group by story_id ────────────────────────────────────────
    by_story: dict[int, list[dict]] = {}
    for a in articles:
        sid = a["story_id"]
        if sid is None:
            continue
        by_story.setdefault(sid, []).append(a)

    # ─── 6. Editorial layer: label, synthesis, timeline, origin ──────
    story_texts         = load_story_texts(conn, story_ids, output_lang)
    visible_article_ids = [a["id"] for a in articles if a.get("id") is not None]
    updates_by_story    = load_story_updates(
        conn, story_ids, visible_article_ids, output_lang,
    )
    origins_by_story    = load_story_origins(conn, story_ids, output_lang)

    # Story status — surfaced for the same reason as in Library (drives
    # destructive-action confirms in the SPA).
    cur.execute(
        "SELECT id, status FROM stories WHERE id = ANY(%s)",
        (story_ids,),
    )
    status_by_story = {row[0]: row[1] for row in cur.fetchall()}

    # ─── 7. Build cluster payloads ───────────────────────────────────
    stories_render: list[dict] = []
    for sid in story_ids:  # preserves added_at DESC ordering
        sub = by_story.get(sid)
        if not sub:
            # Story still referenced but its articles are gone (cleanup
            # purged them). Skip silently rather than render empty.
            continue
        sub_sorted = sorted(
            sub,
            key=pub_sort_key,
            reverse=True,
        )

        texts = story_texts.get(sid, {})
        cluster = enrich_for_render(
            sub_sorted, texts.get("label", ""), texts.get("synthesis"),
            display_origin=origins_by_story.get(sid),
            updates=updates_by_story.get(sid, []),
        )
        cluster["story_id"] = sid
        cluster["added_at"] = added_at[sid].isoformat() if added_at[sid] else None
        cluster["status"]   = status_by_story.get(sid)
        stories_render.append(cluster)

    return {
        "folder":     folder,
        "stories":    stories_render,
        # Folders don't have a singleton concept — every entry is a
        # full cluster (we don't file singletons today, they're attached
        # to stories at the source level). Empty list for shape parity
        # with WatchData.
        "singletons": [],
        "stats": {
            "n_stories":    len(stories_render),
            "n_singletons": 0,
            "n_articles":   len(articles),
        },
    }
