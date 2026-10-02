"""
get_story — full detail of a single news story.

A story is a cluster of articles covering the same event.
`search_stories` returns lightweight summaries across the catalog;
this tool zooms in on one specific story and returns:

  - The narrative layer: label, LLM synthesis, origin paragraph,
    timeline of updates — in English, as the worker writes them.
  - **Whole-story aggregates** computed across every attached article
    (no pagination loss):
      `n_total_articles`, `n_distinct_sources`, `top_entities`,
      `category_distribution`, `country_distribution`.
    The agent answers compositional questions ("which entities dominate?",
    "how many countries are involved?") without reading every article.
  - **A light, paginated list of articles** with just enough metadata
    to scan (title, source, lang, date, URL, snippet). Heavy
    per-article metadata (entities, categories, keywords, paywall,
    author, image, raw text) lives in `get_article(article_id)` —
    the agent fetches it only when it actually needs the detail.
  - **Optional `boolean_query` filter on the articles list**. When set,
    only articles matching the DSL string are returned. Same syntax as
    `search_stories`. Useful for intra-story questions
    like "which articles in this story mention Macron?"
    (`boolean_query="entity:Q3052772"`) or "which French opinions?"
    (`boolean_query="lang:fr AND article_type:opinion"`). The
    whole-story aggregates above are NOT filtered — they always reflect
    the full story, so the agent keeps the global context.

# Why light list + pagination + aggregates

A large story (300+ articles) can't return its full per-article
metadata in one shot without overflowing MCP clients' result size
limits (~50k chars on Claude Desktop). The light projection + pre-
computed aggregates + filter parameter give the agent the same
analytical power without the payload tax:

  - "Compositional" questions → read the aggregates.
  - "Subset" questions → use `boolean_query` to filter the article list.
  - "Detail on this specific article" → `get_article(id)`.
"""

from src.boolean_query import (
    BooleanQueryError,
    compile_to_where,
)
from src.boolean_query import (
    parse as _parse_boolean,
)
from src.db import get_connection

# Default + cap for the per-call article slice. 100 fits most stories
# in one shot; the 200 ceiling protects clients against accidental
# wide pulls.
DEFAULT_ARTICLES_LIMIT = 100
MAX_ARTICLES_LIMIT     = 200

# How much of the article summary ships in the light list. 120 chars is
# enough to disambiguate articles by snippet and let the LLM decide
# which one to fetch in full via `get_article`.
SNIPPET_MAX_CHARS = 120

# How many top-mentioned entities to return in the story-level
# aggregate. Constant payload (~2-3 KB) regardless of story size.
TOP_ENTITIES_LIMIT = 20


def _safe_iso(dt) -> str | None:
    return dt.isoformat() if dt is not None else None


def get_story(
    story_id: int,
    boolean_query: str | None = None,
    articles_offset: int = 0,
    articles_limit: int = DEFAULT_ARTICLES_LIMIT,
) -> dict | None:
    """Return one story with story-level aggregates and a paginated
    article list (optionally filtered).

    Args:
        story_id: the integer story id, as returned by `search_stories`.
        boolean_query: optional Lucene-syntax DSL string applied to the
            articles list. Same grammar as in `search_stories`
            (lang:, entity:Q…, "phrase"~N, etc.).
            **The story-level aggregates above (`n_total_articles`,
            `top_entities`, distributions, etc.) are NOT affected by
            this filter** — they always reflect the whole story so the
            agent keeps the global context. Use the filter to drill
            into a subset, then optionally call `get_article(id)` on
            specific results.
        articles_offset: how many articles to skip before the slice
            returned in `articles`. Default 0. Pair with
            `articles_next_offset` from the previous response to
            paginate big stories.
        articles_limit: how many articles to return in `articles`.
            Default 100, max 200.

    Returns:
        A dict shaped like:

        - Narrative layer:
            `story_id`, `status`, `created_at`, `last_article_at`,
            `label`, `synthesis`, `origin`, `timeline_updates`.

        - Whole-story aggregates (always across every attached
          article, regardless of filter):
            `n_total_articles`, `n_distinct_sources`,
            `top_entities` (list of up to 20 entities with their
            corpus-presence in the story), `category_distribution`
            (dict category → count), `country_distribution` (dict
            subject country → count).

        - Filter & pagination layer:
            `boolean_query_applied` — echoed query string or null.
            `n_matching_filter` — articles matching the filter
                (= n_total_articles when no filter).
            `articles_returned`, `articles_has_more`,
                `articles_next_offset`.

        - The articles slice (light projection):
            `articles`: list of `{article_id, title, source: {name},
                lang, published_at, url, snippet}`.

    Returns None when no story matches the id.

    Raises:
        ValueError on out-of-range args or on a `boolean_query` syntax
        error (with a clear message pointing to the column where the
        compiler failed).
    """
    # ─── Args validation ───────────────────────────────────────────────
    if not isinstance(story_id, int) or story_id <= 0:
        raise ValueError(f"story_id must be a positive integer, got {story_id!r}")
    if not isinstance(articles_offset, int) or articles_offset < 0:
        raise ValueError(
            f"articles_offset must be a non-negative integer, "
            f"got {articles_offset!r}"
        )
    if not isinstance(articles_limit, int) or articles_limit <= 0:
        raise ValueError(
            f"articles_limit must be a positive integer, got {articles_limit!r}"
        )
    if articles_limit > MAX_ARTICLES_LIMIT:
        raise ValueError(
            f"articles_limit capped at {MAX_ARTICLES_LIMIT}, "
            f"got {articles_limit}"
        )

    # Compile the optional boolean_query up-front so a syntax error
    # surfaces to the caller cleanly (and before we hit any DB query).
    filter_sql: str | None = None
    filter_params: list = []
    if boolean_query and boolean_query.strip():
        try:
            tree = _parse_boolean(boolean_query)
            compiled_sql, compiled_params = compile_to_where(tree, alias="a")
        except BooleanQueryError as e:
            raise ValueError(f"boolean_query syntax error: {e}")
        if compiled_sql and compiled_sql != "TRUE":
            filter_sql = compiled_sql
            filter_params = list(compiled_params)

    conn = get_connection()
    try:
        cur = conn.cursor()

        # ─── 1. Story metadata ─────────────────────────────────────────
        cur.execute(
            """
            SELECT id, status, created_at, last_attached_at, latest_pub,
                   label, synthesis_normalized, origin_normalized
              FROM stories
             WHERE id = %s
            """,
            (story_id,),
        )
        row = cur.fetchone()
        if row is None:
            return None  # caller surfaces "story not found"

        (
            sid, status, created_at, last_attached_at, latest_pub,
            label, synthesis, origin,
        ) = row

        # ─── 2. Whole-story aggregates (n_total, distinct sources) ──────
        # Always over EVERY attached article (no filter) — gives the
        # agent the global context regardless of what subset the
        # boolean_query is targeting.
        cur.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT s.id)
              FROM story_items sa
              JOIN items a ON a.id = sa.item_id
              LEFT JOIN sources s ON s.id = a.source_id
             WHERE sa.story_id = %s
            """,
            (story_id,),
        )
        n_total_articles, n_distinct_sources = cur.fetchone()

        # ─── 3. Top entities across the story ──────────────────────────
        # Counts distinct articles per entity, capped at TOP_ENTITIES_LIMIT.
        # JOIN on entities is necessary to surface labels + Q-ids the
        # agent can drop back into `boolean_query="entity:Q…"`.
        cur.execute(
            """
            SELECT e.wikidata_id, e.canonical_label, e.kind,
                   COUNT(DISTINCT ae.item_id) AS n_articles
              FROM item_entities ae
              JOIN entities         e  ON e.id = ae.entity_id
              JOIN story_items   sa ON sa.item_id = ae.item_id
             WHERE sa.story_id = %s
               AND e.status    = 'active'
             GROUP BY e.id, e.wikidata_id, e.canonical_label, e.kind
             ORDER BY n_articles DESC, e.canonical_label ASC
             LIMIT %s
            """,
            (story_id, TOP_ENTITIES_LIMIT),
        )
        top_entities = [
            {
                "qid":        qid,
                "label":      lbl,
                "kind":       kind,
                "n_articles": int(n),
            }
            for qid, lbl, kind, n in cur.fetchall()
        ]

        # ─── 4. Category & country distributions ───────────────────────
        # `items.category` and `items.countries` are native JSONB
        # arrays. `jsonb_array_elements_text` unnests
        # them so we can GROUP BY the textual value.
        cur.execute(
            """
            SELECT cat, COUNT(*) AS n FROM (
                SELECT jsonb_array_elements_text(
                          COALESCE(a.category, '[]'::jsonb)
                       ) AS cat
                  FROM items a
                  JOIN story_items sa ON sa.item_id = a.id
                 WHERE sa.story_id = %s
            ) sub
            GROUP BY cat
            ORDER BY n DESC, cat ASC
            """,
            (story_id,),
        )
        category_distribution = {cat: int(n) for cat, n in cur.fetchall()}

        cur.execute(
            """
            SELECT country, COUNT(*) AS n FROM (
                SELECT jsonb_array_elements_text(
                          COALESCE(a.countries, '[]'::jsonb)
                       ) AS country
                  FROM items a
                  JOIN story_items sa ON sa.item_id = a.id
                 WHERE sa.story_id = %s
            ) sub
            GROUP BY country
            ORDER BY n DESC, country ASC
            """,
            (story_id,),
        )
        country_distribution = {country: int(n) for country, n in cur.fetchall()}

        # ─── 5. Filter-aware article count ─────────────────────────────
        # When a boolean_query is set, we surface BOTH numbers so the
        # agent sees "147 articles total, 89 match your filter".
        if filter_sql:
            count_sql = f"""
                SELECT COUNT(*)
                  FROM story_items sa
                  JOIN items a ON a.id = sa.item_id
                  LEFT JOIN sources s ON s.id = a.source_id
                 WHERE sa.story_id = %s
                   AND ({filter_sql})
            """
            cur.execute(count_sql, [story_id, *filter_params])
            n_matching_filter = int(cur.fetchone()[0] or 0)
        else:
            n_matching_filter = n_total_articles

        # ─── 6. Paginated light list of articles (filtered if requested) ─
        list_where = "sa.story_id = %s"
        list_params: list = [story_id]
        if filter_sql:
            list_where += f" AND ({filter_sql})"
            list_params.extend(filter_params)

        cur.execute(
            f"""
            SELECT
                a.id,
                COALESCE(a.title_normalized, a.title) AS title,
                COALESCE(a.summary_normalized, a.summary) AS summary,
                a.lang,
                a.url,
                COALESCE(a.published_at, a.fetched_at) AS published_at,
                s.name AS source_name
              FROM story_items sa
              JOIN items a ON a.id = sa.item_id
              LEFT JOIN sources s ON s.id = a.source_id
             WHERE {list_where}
             ORDER BY COALESCE(a.published_at, a.fetched_at) ASC, a.id ASC
             OFFSET %s
             LIMIT %s
            """,
            [*list_params, articles_offset, articles_limit],
        )
        article_rows = cur.fetchall()

        # ─── 7. Timeline updates ───────────────────────────────────────
        # Small data — always full, no pagination, no filter.
        cur.execute(
            """
            SELECT id, content, source_item_id, added_at
              FROM story_updates
             WHERE story_id = %s
             ORDER BY added_at ASC
            """,
            (story_id,),
        )
        update_rows = cur.fetchall()
    finally:
        conn.close()

    # ─── Build articles payload ────────────────────────────────────────
    articles = []
    for r in article_rows:
        a_id, title, summary, lang, url, published_at, source_name = r
        snippet = (summary or "").strip()
        if len(snippet) > SNIPPET_MAX_CHARS:
            snippet = snippet[:SNIPPET_MAX_CHARS].rstrip() + "…"
        articles.append({
            "article_id":   a_id,
            "title":        title or "",
            "source": {
                "name": source_name,
            },
            "lang":         lang,
            "published_at": _safe_iso(published_at),
            "url":          url,
            "snippet":      snippet,
        })

    articles_returned = len(articles)
    # Pagination is relative to the FILTERED set (n_matching_filter),
    # not the whole story — otherwise `has_more` would lie when a
    # filter narrowed the result well under the offset.
    articles_has_more = (articles_offset + articles_returned) < n_matching_filter
    articles_next_offset = (
        articles_offset + articles_returned if articles_has_more else None
    )

    updates = [
        {
            "update_id":         u[0],
            "content":           u[1],
            "source_article_id": u[2],
            "added_at":          _safe_iso(u[3]),
        }
        for u in update_rows
    ]

    return {
        # Narrative
        "story_id":               sid,
        "status":                 status,
        "created_at":             _safe_iso(created_at),
        "last_article_at":        _safe_iso(latest_pub or last_attached_at),
        "label":                  label,
        "synthesis":              synthesis,
        "origin":                 origin,
        "timeline_updates":       updates,

        # Whole-story aggregates (always unfiltered)
        "n_total_articles":       n_total_articles,
        "n_distinct_sources":     n_distinct_sources,
        "top_entities":           top_entities,
        "category_distribution":  category_distribution,
        "country_distribution":   country_distribution,

        # Filter & pagination
        "boolean_query_applied":  boolean_query if filter_sql else None,
        "n_matching_filter":      n_matching_filter,
        "articles_returned":      articles_returned,
        "articles_has_more":      articles_has_more,
        "articles_next_offset":   articles_next_offset,
        "articles":               articles,
    }
