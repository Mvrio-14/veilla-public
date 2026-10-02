"""
The Watch: every article the reader's monitors delivered in the window,
grouped into story cards (two visible articles or more) and single rows.

No LLM call happens here — everything was computed by the worker. When a
translation is missing (the worker hasn't caught up yet), the reader gets
the English: the story's label and synthesis, the article's normalised
title and summary.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from src.languages import PIPELINE_LANGUAGE
from src.loaders.common import (
    cluster_recency_max,
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

if TYPE_CHECKING:
    from src.watch_query import QueryState


def load_visible_articles(
    conn,
    monitor_ids: list[int],
    window_hours: int,
    output_lang: str,
    query_state: QueryState | None = None,
) -> list[dict]:
    """
    Load all items delivered by the user's monitors. Two-rule selection:

      A. The item was delivered by one of `monitor_ids` AND matches the active
         `query_state` filters — including the period_hours cutoff,
         the full-text search query, keywords, categories, entity picks,
         country filters, etc. When `query_state` is None, a default
         state derived from `window_hours` is synthesized (= legacy
         behaviour, no extra filters beyond the time window).

      B. The item was delivered by one of `monitor_ids` AND belongs to a story that
         already has at least one article matching rule A (= "active
         story" — at least one recent member that matches the filters).

      Rule B pulls in the older articles of an ongoing story so the user
      gets the FULL context rather than a 24h-truncated slice. Without
      it the timeline shows only fragments of long-running stories like
      sagas and the origin paragraph appears with a wrong timestamp
      (the earliest *visible* article is not the actual seed).

      Important — when filters are active, Rule B preserves CONTEXT but
      does NOT broaden the filter set: an older article shows up only if
      the story passed the Rule A filter via at least one recent article.
      An older article whose lang/category/source disagrees with the
      filter still appears in the timeline of a matching story (= the
      user wanted these stories, here's their full history).

    Items outside `monitor_ids` are never returned, even if they
    belong to an active story. Each article also carries `story_id`,
    which is never None: an article is not returned at all until the
    clusterer has given it a story (see the cluster-readiness note in
    the SQL below).
    """
    # Local import to avoid a module-level cycle (watch_query imports
    # taxonomy which is fine, but keeping it lazy here means tests can
    # import this module without pulling the resolver in.
    from src.watch_query import QueryState, build_article_where

    # Synthesize a minimal QueryState from `window_hours` when the caller
    # didn't pass one (legacy code path). period_hours mirrors the lookback,
    # and every other filter is empty — net effect is the pre-refactor
    # behaviour.
    if query_state is None:
        query_state = QueryState(period_hours=int(window_hours))

    # Resolver-driven WHERE: the canonical filter set the caller wants
    # applied to the article universe. Used twice in the SQL below (in
    # the active_story_ids CTE and in Rule A of the main SELECT), so we
    # need to pass the parameter list twice as well. The period_hours
    # cutoff lives inside `resolver_where` — no separate `cutoff` variable
    # exists post-refactor.
    #
    # `include_visibility=False` skips the redundant `archive_seed = FALSE`
    # clause — the `in_scope_articles` CTE below already gates on it, so
    # repeating the filter at the article-level WHERE only burns planner
    # time recognising it as a no-op on the pre-filtered set.
    resolver_where, resolver_params = build_article_where(
        query_state, include_visibility=False,
    )
    resolver_sql = " AND ".join(resolver_where)
    # `active_story_ids` joins `sources` only when the resolver references
    # it (source-country filters emit `s.country`). For a filter-less
    # /watch — the common case — the join would be dead weight.
    extra_joins = ""
    if "s." in resolver_sql:
        extra_joins = "\n              LEFT JOIN sources s ON s.id = a.source_id"
    cur = conn.cursor()
    # DISTINCT ON canonical_url collapses items that share one (Bloomberg
    # Markets + Bloomberg Crypto syndicating the same story). `feeds_list`
    # aggregates every monitor that delivered the canonical content, and
    # `feed_name` / `feed_url` name the first of them.
    # The pre-CTE shape of this query measured ~110s on 61 feeds
    # because the correlated `feeds_list` sub-select forced one full
    # `Seq Scan on articles` per returned row (1648 loops × 44k rows =
    # 16.9M buffer hits). The refactor replaces every correlated path
    # with a pre-built CTE the planner joins once:
    #
    #   - `in_scope_articles` : the universe of items delivered by the
    #     user's monitors.
    #   - `active_story_ids`  : stories with ≥1 recent in-scope article.
    #     Replaces the giant `IN (SELECT DISTINCT …)` subquery for
    #     rule B (= "show older articles of an ongoing story").
    #   - `canonical_feeds`   : the `feeds_list` json_agg, but built once
    #     per canonical_url for the in-scope universe instead of once
    #     per returned row.
    #
    # Net: each CTE executes once, then the main SELECT is a chain of
    # cheap hash/nested-loop joins on indexed columns.
    #
    # Per-user-lang projection:
    #   SELECTing the entire `title_translations` / `summary_
    #   translations` JSONBs (the dict of every cached translation per
    #   article — 5-15 KB each × 1500 articles = ~15-20 MB for a large
    #   selection of feeds) would be wasteful. The SPA only needs the entry for the viewer's lang,
    #   so we extract it inline via `->> %s` and ship just that string.
    #   Both `title_translations` and `summary_translations` are native
    #   JSONB (no cast needed). Empty/NULL means
    #   "no cached translation" and the Python resolver falls back to
    #   title_normalized.
    cur.execute(
        """
        WITH recent_in_scope AS MATERIALIZED (
            -- ── CTE 1/4 ── articles in-scope AND in the user-chosen
            -- time window. This is the small set
            -- that:
            --   - drives the active_story_ids derivation
            --   - is what the user actually sees for Rule A
            --
            -- Why MATERIALIZED: without it the planner inlines and
            -- re-evaluates the same Bitmap Heap Scan three times (once
            -- per downstream CTE that references it). Materialising
            -- pins the result in one place, downstream joins are
            -- hash-joins on the cached IDs.
            --
            -- Time filter uses idx_items_effective_pub (partial
            -- index). The OR-on-correlated-cols
            -- `(lang = X OR title_translations ? X)` combines
            -- idx_items_lang + idx_items_title_translations_gin
            -- via Postgres BitmapOr — confirmed in EXPLAIN ANALYZE.
            --
            -- Translation-readiness: an article is "ready for this
            -- user" iff its source lang matches output_lang OR a cached
            -- translation exists. Without this, the loader leaks
            -- pre-translation articles whose translator pass hasn't
            -- caught up yet.
            --
            -- Cluster-readiness, same idea one step further: an article
            -- is shown only once it belongs to a story. Normalisation
            -- happens at step 2 of the worker pass and clustering at
            -- step 6, with extraction, entity resolution and embedding
            -- in between — minutes on a large batch. An article caught
            -- in that gap used to reach the UI with a null story id,
            -- and the interface has no row shape for "article that
            -- belongs to nothing": the detail panel is keyed by story,
            -- so clicking one opened nothing and closed whatever was
            -- open, and the read-marking call posted /stories/null/read.
            --
            -- Waiting costs nothing that is not already being waited
            -- for. The two filters above hold the article back until it
            -- is normalised and translated; this one holds it until it
            -- also has a label, a synthesis and entities. And it loses
            -- nothing: `cluster_pending` gives a story to every article
            -- it processes — the `_is_singleton_candidate` branch skips
            -- the *matching* step, not the story creation — so having
            -- no story is always a state in transit, never a final one.
            --
            -- Consequence worth keeping in mind: `story_id` is now
            -- non-null on every row this returns, which the frontend
            -- type has always claimed and can finally rely on.
            SELECT DISTINCT a.id,
                            COALESCE(a.canonical_url, a.url) AS canonical_key
              FROM items a
              JOIN monitor_items mi ON mi.item_id = a.id
             WHERE mi.monitor_id = ANY(%s)
               AND a.archive_seed       = FALSE
               AND a.title_normalized IS NOT NULL
               AND TRIM(a.title_normalized) <> ''
               AND EXISTS (
                   SELECT 1 FROM story_items sa WHERE sa.item_id = a.id
               )
               AND COALESCE(a.published_at, a.fetched_at)
                     > NOW() - (%s::int * INTERVAL '1 hour')
               AND (
                     %s          -- an English reader reads title_normalized
                  OR a.lang = %s
                  OR (a.title_translations ? %s)
               )
        ),
        active_story_ids AS MATERIALIZED (
            -- ── CTE 2/4 ── stories that have at least one article in
            -- recent_in_scope AND matching the FULL resolver filter
            -- set (= time window + every qs criteria the user picked:
            -- categories, entities, source_country, etc.).
            --
            -- A story whose only recent in-scope articles fail any of
            -- the qs criteria stays inactive — the user doesn't see
            -- context from unrelated stories.
            --
            -- The sources join is inserted only when the resolver
            -- references it (probed above).
            SELECT DISTINCT sa.story_id
              FROM story_items sa
              JOIN items      a   ON a.id          = sa.item_id
              JOIN recent_in_scope ris ON ris.id     = a.id""" + extra_joins + """
             WHERE """ + resolver_sql + """
        ),
        older_in_scope AS MATERIALIZED (
            -- ── CTE 3/4 ── older articles of active stories that
            -- belong to the user's scope but fall OUTSIDE the time
            -- window. This is what gives Rule B (= "show the full
            -- timeline of an active story") without materialising
            -- every in-scope article ever ingested.
            --
            -- The filter `story_id IN active_story_ids` is the key
            -- selectivity: instead of scanning all in-scope articles
            -- (~30k+ for 91 feeds' full history), Postgres
            -- looks up the small active_story_ids set (~500-1000)
            -- in the indexed story_items.story_id and joins
            -- outwards. We exclude articles already in
            -- recent_in_scope to avoid duplicates in the UNION below.
            --
            -- Same filters as recent_in_scope (archive_seed,
            -- title_normalized) but NO time filter — that's the
            -- whole point: pull articles older than window_hours
            -- when they belong to a story that IS active. No
            -- translation-readiness filter either: an article in an
            -- active timeline may have been ingested before its
            -- translation was cached; we still want it visible.
            SELECT DISTINCT a.id,
                            COALESCE(a.canonical_url, a.url) AS canonical_key
              FROM items a
              JOIN story_items   sa ON sa.item_id = a.id
              JOIN monitor_items mi ON mi.item_id = a.id
             WHERE sa.story_id IN (SELECT story_id FROM active_story_ids)
               AND mi.monitor_id = ANY(%s)
               AND a.archive_seed       = FALSE
               AND a.title_normalized IS NOT NULL
               AND TRIM(a.title_normalized) <> ''
               AND NOT EXISTS (
                   SELECT 1 FROM recent_in_scope ris WHERE ris.id = a.id
               )
        ),
        in_scope_articles AS MATERIALIZED (
            -- ── CTE 4/4 ── UNION of recent + older. This is the
            -- final article universe consumed by canonical_feeds and
            -- the main SELECT. Same shape (id, canonical_key) as the
            -- pre-refactor single CTE so downstream queries are
            -- unchanged.
            SELECT id, canonical_key FROM recent_in_scope
            UNION
            SELECT id, canonical_key FROM older_in_scope
        ),
        canonical_feeds AS MATERIALIZED (
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
            -- Batch the per-article entities aggregation INSTEAD OF the
            -- correlated subquery in the main SELECT below. The previous
            -- shape (a sub-SELECT per row) is the textbook N+1 pattern:
            -- on a 1666-row result set it fired 1666 sequential
            -- index-lookups against item_entities + entities,
            -- accumulating to ~16s (cf. Supabase doc
            -- `data-n-plus-one.md`). Aggregating once over the in-scope
            -- set + hash-joining drops that to ~50-200ms in the same
            -- plan EXPLAIN ANALYZE benchmarks.
            --
            -- Not tagged `MATERIALIZED` on purpose — the planner is
            -- usually right when a CTE is referenced once. If a future
            -- EXPLAIN reveals the planner inlines this and re-runs it
            -- per row, add the keyword.
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
                   -- Attribution comes from the item's own source,
                   -- which a Google News monitor resolves per item
                   -- from the RSS `<source>` tag (Reuters, Le Monde…).
                   s.country AS source_country,
                   COALESCE(a.published_at, a.fetched_at) AS published_at,
                   s.name AS source_name,
                   a.keywords,
                   -- Linked entities. Sourced from the
                   -- `entities_per_article` CTE above which batches the
                   -- aggregation in a single GROUP BY pass. NULL means
                   -- "this article has no resolved entities" (= an
                   -- article whose extractor pass produced nothing) —
                   -- COALESCE flattens that to an empty JSON array,
                   -- matching the legacy correlated-subquery shape.
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
              JOIN first_monitor      fm ON fm.item_id = a.id
              -- The item carries its canonical publisher, which a
              -- Google News monitor does not have.
              LEFT JOIN sources       s  ON s.id   = a.source_id
              LEFT JOIN story_items sa ON sa.item_id = a.id
              LEFT JOIN canonical_feeds cf
                     ON cf.canonical_key = COALESCE(a.canonical_url, a.url)
              -- entities_per_article: replaces the legacy correlated
              -- subquery (was N+1 against item_entities). One LEFT
              -- JOIN here, plus the CTE batch-aggregates everything in
              -- one pass. NULL means no resolved entities for that
              -- article (handled via COALESCE in the SELECT).
              LEFT JOIN entities_per_article epa ON epa.item_id = a.id
             WHERE (""" + resolver_sql + """)
                OR sa.story_id IN (SELECT story_id FROM active_story_ids)
          ORDER BY COALESCE(a.canonical_url, a.url),
                   COALESCE(a.published_at, a.fetched_at) DESC
        ) deduped
        ORDER BY published_at DESC
        """,
        (
            list(monitor_ids),        # recent_in_scope: mi.monitor_id = ANY(%s)
            int(query_state.period_hours),  # recent_in_scope: time window (hours)
            output_lang == PIPELINE_LANGUAGE,  # recent_in_scope: English reader
            output_lang,              # recent_in_scope: a.lang = %s
            output_lang,              # recent_in_scope: a.title_translations ? %s
            *resolver_params,         # active_story_ids: resolver WHERE
            list(monitor_ids),        # older_in_scope: mi.monitor_id = ANY(%s)
            output_lang,              # title_translations ->> lang (main SELECT)
            output_lang,              # summary_translations ->> lang (main SELECT)
            *resolver_params,         # main SELECT Rule A: resolver WHERE
        ),
    )
    rows = cur.fetchall()

    articles = [
        {
            "id":                   r[0],
            "source":               r[13] or r[1],
            "feed_name":            r[1],
            "title":                r[2],
            "url":                  r[3],
            "summary":              r[4] or "",
            "title_normalized":     r[5] or r[2],
            "summary_normalized":   r[6] or "",
            "image_url":            r[7],
            "lang":                 r[8],
            "category":             (parse_category(r[9]) if r[9] else ["Other"]),
            "countries":            parse_json_list(r[10]),
            "source_country":       r[11],
            "published_at":         r[12],
            "keywords":             parse_json_list(r[14]),
            # entities is a LIST of {entity_id, qid, name, kind,
            # country, image_url, description, salience, surface_form}
            # built by the JSONB-agg subquery above. Every
            # consumer (frontend sidebar, aggregations.py, MCP) reads
            # the flat list and groups/filters by `kind` at render time.
            "entities":             parse_json_list(r[15]),
            "source_url":           f"https://{r[16]}" if r[16] else "",
            "feed_url":             r[17] or "",
            "article_type":         r[18],
            # Pre-extracted user-lang translations.
            # NULL when there's no cached translation for output_lang —
            # the Python resolver then falls back to title_normalized.
            "title_for_user_lang":   r[19],
            "fetched_at":            r[20],
            "story_id":              r[21],
            "summary_for_user_lang": r[22],
            "feeds":                 dedup_feeds(parse_json_list(r[23])),
            # RSS author fields surfaced raw to the SPA — feedparser stores
            # the publisher-declared byline in `<author>` / `<dc:creator>`
            # (single string) and Atom's `<author><name>X</name>` repeated
            # (list of {name, email, href} dicts). Both are kept verbatim;
            # the frontend builds a display string with light normalization
            # (surfaced so fake bylines like "Le Monde", wire credits like
            # "AFP", or weird formats can be spotted from the UI).
            "author":                r[24],
            "authors":               parse_json_list(r[25]),
        }
        for r in rows
    ]
    return articles


def load_read_article_ids(
    conn, user_id: str, article_ids: list[int],
) -> list[int]:
    """
    Return the subset of `article_ids` the user has already read.

    Scoped to the watch's visible articles so the payload stays small
    (no point shipping a Set covering articles the user can't see anyway).
    """
    if not article_ids:
        return []
    cur = conn.cursor()
    cur.execute(
        """SELECT item_id FROM user_item_reads
           WHERE user_id = %s AND item_id = ANY(%s)""",
        (user_id, article_ids),
    )
    return [row[0] for row in cur.fetchall()]


def load_watch(
    conn,
    user_id: str,
    profile: dict,
    monitor_ids: list[int],
    window_hours: int,
    query_state: QueryState | None = None,
) -> tuple[list[dict], list[dict], dict]:
    """
    Main entry point for the Watch screen. Reads pre-computed caches and
    performs no LLM call.

    The universe is the items delivered by the user's monitors. A story
    with two or more of them becomes a cluster card, carrying its label
    and synthesis in the reader's language (see `load_story_texts`), its
    origin paragraph and its timeline of updates. A story with one becomes
    a singleton row.

    Args:
        conn:          open DB connection
        user_id:       UUID of the user (from users.id)
        profile:       full user profile dict (read for output_lang)
        monitor_ids:   the monitors the user subscribes to
        window_hours:  lookback window for articles

    Returns:
        (stories, singletons, stats)
    """
    pref         = profile.get("structured", {}).get("output_preference", {})
    output_lang  = (pref.get("lang") or "fr").lower()

    # 1. Load the items the user's monitors delivered, plus the older
    #    items of the stories they belong to.
    articles = load_visible_articles(
        conn, monitor_ids, window_hours, output_lang,
        query_state=query_state,
    )
    # 2. Resolve display title + summary for each article (no LLM, just
    #    cache lookup). Track per-field "is translated" flags so the SPA
    #    knows whether to render the source-lang chip.
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
    # 3. Group by story_id.
    by_story: dict[int, list[dict]] = {}
    for a in articles:
        sid = a["story_id"]
        # Unreachable since the cluster-readiness filter — the loader no
        # longer returns story-less articles. Written as a drop rather
        # than deleted outright so that a regression in that SQL costs
        # one article for one pass, instead of putting a row the UI
        # cannot key back into the feed. The detail panel, the read
        # marking and the unread badge are all keyed by story id; a row
        # without one breaks the three of them at once, which is the
        # failure this guard and that filter both exist to prevent.
        if sid is None:
            continue
        by_story.setdefault(sid, []).append(a)

    # 4. Editorial layer for the stories that render as clusters: label,
    #    synthesis, timeline and origin, all in the reader's language.
    multi_story_ids = [sid for sid, sub in by_story.items() if len(sub) >= 2]
    story_texts     = load_story_texts(conn, multi_story_ids, output_lang)
    visible_article_ids = [a["id"] for a in articles if a.get("id") is not None]
    updates_by_story = load_story_updates(
        conn, multi_story_ids, visible_article_ids, output_lang,
    )
    origins_by_story = load_story_origins(conn, multi_story_ids, output_lang)
    # 5. Build stories vs singletons output.
    stories_render:    list[dict] = []
    # Starts empty: every singleton rendered from here on is a story
    # with a single visible article, which by definition has a story id.
    singletons_render: list[dict] = []

    for sid, visible in by_story.items():
        visible_sorted = sorted(visible, key=pub_sort_key, reverse=True)

        if len(visible_sorted) < 2:
            singletons_render.extend(visible_sorted)
            continue

        texts = story_texts.get(sid, {})
        stories_render.append(enrich_for_render(
            visible_sorted, texts.get("label", ""), texts.get("synthesis"),
            display_origin=origins_by_story.get(sid),
            updates=updates_by_story.get(sid, []),
        ))

    # 6. Sort by recency DESC for both clusters and singletons. Cluster
    #    recency = max published_at across its articles (the cluster bubbles
    #    up whenever a fresh article attaches). Singletons sort on their
    #    own published_at. The frontend's "Tout" tab interleaves the two
    #    using the same key, so a hot singleton can outrank a stale cluster
    #    no matter how many sources cover the cluster. Score is still
    #    computed (kept in payload for future use / debug) but no longer
    #    drives the order. The recency helpers live at module scope so the
    #    /watch endpoint's pagination cursor reuses the EXACT same ordering.
    stories_render.sort(key=cluster_recency_max, reverse=True)
    singletons_render.sort(key=pub_sort_key, reverse=True)

    stats = {
        "n_articles":   len(articles),
        "n_stories":    len(stories_render),
        "n_singletons": len(singletons_render),
    }

    return stories_render, singletons_render, stats
