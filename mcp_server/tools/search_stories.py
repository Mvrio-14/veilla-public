"""
search_stories — the central MCP tool for navigating the news feed.

Mirrors the frontend Advanced filter shape (`webapp/lib/filter.ts`),
minus the per-entity filters (persons/orgs/events/markets/products)
which the normalizer extracts unevenly and surface too much noise to
be useful in a conversational tool. Use the broader `keywords` argument
instead — it AND-matches against title + summary + the entities haystack
post-load.

Backend implementation is hybrid (validated 2026-06-17):
  - SQL applies the heavy filters (time range, source, country/region,
    lang, category, article type, subject countries).
  - Python applies the fine filters (free-text query, keywords,
    excluded keywords) and the per-story aggregation.

Searches the articles delivered by the feeds of the user named by
VEILLA_MCP_USER_SLUG (see mcp_server/_identity.py).
"""
import json
from datetime import datetime, timedelta, timezone

# ── Constants ─────────────────────────────────────────────────────────
from mcp_server._identity import current_user_slug
from mcp_server.tools._filters import resolve_country_filter
from src.boolean_query import (
    BooleanQueryError,
    compile_to_where,
)
from src.boolean_query import (
    parse as _parse_boolean,
)
from src.db import get_connection

# Max look-back from "now". 14 days matches Veilla's article retention
# (pg_cron cleanup deletes >14d articles unless saved / in a folder),
# so anything further back simply isn't in the DB anymore. Default for
# unset queries stays at 24h — the agent should explicitly opt in to
# longer windows when its query is narrow (entity, specific feeds…),
# since a wide-open 14-day scan can touch a lot of articles.
MAX_PERIOD_HOURS = 336  # = 14 days

DEFAULT_LIMIT  = 50
MAX_LIMIT      = 200

# How many articles we load from the DB max, regardless of how many
# stories there are. Protects against a wide-open query timing out the
# server or saturating Python memory. At 5000 articles × ~1 KB each =
# ~5 MB, totally fine in RAM but big enough to cover real journalist
# workflows (a 72h window with ~3000 articles is the worst-case orgs).
INTERNAL_ARTICLE_CAP = 5000

# Top sources cap returned per story (summary format). When a story has
# more, we surface a count `n_more_sources` so the LLM knows the list
# is truncated and can call `get_story(id)` for the full breakdown.
MAX_TOP_SOURCES = 5


# ── Helpers ──────────────────────────────────────────────────────────
def _parse_iso(s: str, arg_name: str) -> datetime:
    """Parse an ISO-8601 datetime, accepting trailing 'Z' (UTC)."""
    try:
        # `datetime.fromisoformat` accepts most variants. 'Z' became
        # supported in Python 3.11 but we strip it for safety.
        cleaned = s.strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            # Naive datetime — assume UTC (= the rest of the pipeline is
            # tz-aware UTC).
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError) as e:
        raise ValueError(
            f"{arg_name} must be an ISO-8601 datetime "
            f"(e.g. '2026-06-17T08:00:00Z'), got {s!r}: {e}"
        )


def _resolve_time_window(
    time_from: str | None,
    time_to:   str | None,
    period_hours: int | None,
) -> tuple[datetime, datetime]:
    """Resolve the (from, to) datetime window from the user-facing args.

    Three valid input shapes:
      - `period_hours=N`            → window = [now - N hours, now]
      - `time_from` (+ optional `time_to`) → explicit window
      - Nothing                     → default window = last 24 hours

    Errors out if both `period_hours` and `time_from` are set, or if the
    resolved window stretches beyond MAX_PERIOD_HOURS into the past.
    """
    now = datetime.now(timezone.utc)
    earliest_allowed = now - timedelta(hours=MAX_PERIOD_HOURS)

    if period_hours is not None and (time_from is not None or time_to is not None):
        raise ValueError(
            "Pass either `period_hours` OR (`time_from`/`time_to`), not both. "
            "Use `period_hours` for a rolling window from now; use "
            "`time_from`/`time_to` for an explicit datetime range."
        )

    if period_hours is not None:
        if period_hours <= 0:
            raise ValueError(f"period_hours must be positive, got {period_hours}")
        if period_hours > MAX_PERIOD_HOURS:
            raise ValueError(
                f"period_hours capped at {MAX_PERIOD_HOURS}h (14 days). "
                f"Articles older than that are pruned by the daily cleanup "
                f"unless they're saved or in a folder — fetch those via the "
                f"Library UI."
            )
        return (now - timedelta(hours=period_hours), now)

    if time_from is None and time_to is None:
        # Default: last 24 hours.
        return (now - timedelta(hours=24), now)

    dt_from = _parse_iso(time_from, "time_from") if time_from else earliest_allowed
    dt_to   = _parse_iso(time_to,   "time_to")   if time_to   else now

    if dt_from >= dt_to:
        raise ValueError(
            f"time_from ({dt_from.isoformat()}) must be strictly earlier "
            f"than time_to ({dt_to.isoformat()})."
        )
    if dt_from < earliest_allowed:
        raise ValueError(
            f"time_from is older than {MAX_PERIOD_HOURS}h (14 days) ago. "
            f"Articles older than that are pruned by daily cleanup; only "
            f"saved/foldered stories survive — fetch those via the Library UI."
        )
    return (dt_from, dt_to)


def _normalize_token_list(tokens: list[str] | None) -> list[str] | None:
    """Lowercase, strip, drop empties. Returns None if no usable token."""
    if not tokens:
        return None
    out = [t.strip().lower() for t in tokens if t and t.strip()]
    return out or None


def _build_haystack(row: dict) -> str:
    """Pre-build a lowercased searchable string per article for query /
    keywords matching. Concatenates title + summary + entities + keywords
    so the AND-keyword semantics mirror what the frontend does in
    `articleMatchesAdvanced`.
    """
    parts: list[str] = []
    if row.get("title"):    parts.append(row["title"])
    if row.get("summary"):  parts.append(row["summary"])

    # entities is a JSON string of {persons:[...], orgs:[...], ...}.
    ents_raw = row.get("entities")
    if ents_raw:
        try:
            ents = json.loads(ents_raw) if isinstance(ents_raw, str) else ents_raw
            if isinstance(ents, dict):
                for v in ents.values():
                    if isinstance(v, list):
                        parts.extend(str(x) for x in v if x)
        except (json.JSONDecodeError, TypeError):
            pass

    # keywords is a JSON array of strings.
    kw_raw = row.get("keywords")
    if kw_raw:
        try:
            kws = json.loads(kw_raw) if isinstance(kw_raw, str) else kw_raw
            if isinstance(kws, list):
                parts.extend(str(x) for x in kws if x)
        except (json.JSONDecodeError, TypeError):
            pass

    return " ".join(parts).lower()


def _article_matches_text(
    haystack: str,
    query:    str | None,
    keywords: list[str] | None,
    excluded: list[str] | None,
) -> bool:
    """Apply the free-text filters that we couldn't push to SQL."""
    if query and query.lower() not in haystack:
        return False
    if keywords:
        for k in keywords:                       # AND logic
            if k not in haystack:
                return False
    if excluded:
        for k in excluded:                       # mute on any match
            if k in haystack:
                return False
    return True


# ── Public entrypoint ────────────────────────────────────────────────
def search_stories(
    # ─── Boolean DSL (recommended for non-trivial queries) ─────
    boolean_query: str | None = None,

    # ─── Free-text (simple substring; kept for backwards compatibility) ─
    query:             str | None       = None,
    keywords:          list[str] | None = None,
    excluded_keywords: list[str] | None = None,

    # ─── Temporal (up to 14 days back) ─────
    time_from:    str | None = None,
    time_to:      str | None = None,
    period_hours: int | None = None,

    # ─── Where the source publishes ─────
    source_country: str | None = None,
    source_region:  str | None = None,

    # ─── What the article is about ─────
    subject_country: str | None = None,
    subject_region:  str | None = None,

    # ─── Language / explicit source / feed ─────
    source_langs: list[str] | None = None,
    source_names: list[str] | None = None,
    feed_names:   list[str] | None = None,

    # ─── Topic & format ─────
    categories:             list[str] | None = None,
    excluded_categories:    list[str] | None = None,
    article_types:          list[str] | None = None,
    excluded_article_types: list[str] | None = None,

    # ─── Pagination ─────
    limit:  int = DEFAULT_LIMIT,
    offset: int = 0,
) -> dict:
    """Search stories across the user's feeds with rich filters.

    Stories are clusters of articles covering the same event. Each story
    summary returned here gives label, n_articles, the top contributing
    sources (with the feeds they came in through).

    For the full content of a single story (origin paragraph, synthesis,
    timeline updates, full list of articles), use `get_story(story_id)`.

    Args:
        boolean_query: Lucene-syntax Boolean DSL string. The expressive
            way to filter — supports AND/OR/NOT, parens, "exact phrases",
            `"phrase"~N` proximity (NEAR), and field modifiers including:
              - `lang:fr`
              - `category:Politics`
              - `country:FR`         (source publishing country)
              - `subject_country:UA` (article subject country)
              - `article_type:opinion`
              - `feed:"Le Monde"`
              - `entity:Q3052772`    (canonical Wikidata Q-id — find one
                                       via `search_entities(name)`)
              - `title:Renault`      (substring match, title only)
              - `published:[2026-06-01 TO 2026-06-25]` (TIMESTAMPTZ range)
            Example: `entity:Q3052772 AND (lang:fr OR lang:en) AND
            "reforme retraite"~5`. Combined in AND with every other
            filter (so you can mix `boolean_query` and e.g.
            `source_region='EUR'`). Syntax errors raise a clear
            error before hitting the DB.
        query: simple lowercase substring match on title + summary +
            entities + keywords haystack. Kept for backwards
            compatibility — prefer `boolean_query` for anything
            non-trivial.
        keywords: list of strings. AND logic — every keyword must appear
            in the article haystack. Same caveat as `query` — for richer
            logic, write it as a `boolean_query`.
        excluded_keywords: list of strings. Any match → article excluded.

        time_from: ISO-8601 datetime ('2026-06-17T08:00:00Z'). Lower bound
            of the time window. Max look-back: 14 days.
        time_to: ISO-8601 datetime. Upper bound. Default = now.
        period_hours: alternative shortcut, "last N hours". Mutually
            exclusive with time_from/time_to. Max 336 (14 days). Default
            (none of the three set): last 24 hours. Use shorter windows
            for broad queries, longer windows when filters are narrow.

        source_country: exact match on `sources.country` (ISO 3166-1
            alpha-2 like 'FR'/'US'/'JP', regional tag like 'EUR', or
            'GLB'). To pull every European source, use `source_region`
            instead. Mutually exclusive with `source_region`.
        source_region: broad region — 'EUR' / 'MID' / 'ASI' / 'AFR' /
            'LAT' / 'OCE'. Matches every member country PLUS sources
            tagged at the regional level.

        subject_country: ISO code matching `items.countries` (= places
            the article is ABOUT, set by the normalizer). Independent of
            source_country (Le Monde [FR source] writing about Iran [IR
            subject]).
        subject_region: broad region for the article subject. Same shape
            as `source_region`.

        source_langs: list of ISO 639-1 codes ('fr', 'en', 'de', ...).
            Matches `items.lang`.
        source_names: list of canonical source names ('Le Monde',
            'Reuters', ...). Exact match on `sources.name`.
        feed_names: list of feed names ('Le Monde - Politique',
            'BBC News - World', ...). Exact match on the feed's name.

        categories: list of category names from the 16-bucket taxonomy
            (e.g. 'Geopolitics & Conflicts', 'Economy', 'Technology & AI').
            OR logic.
        excluded_categories: same shape, but excludes.
        article_types: 'news' / 'feature' / 'opinion' / 'interview' /
            'recap' / 'multimedia' / 'institutional'. OR logic.
        excluded_article_types: same shape, but excludes.

        limit: stories returned, default 50, capped at 200.
        offset: pagination. To fetch the next page, pass the previous
            `next_offset` value from the response.

    Returns:
        A dict with:
          - n_stories: int — stories in this response (≤ limit)
          - n_total_matched: int — total stories matching the query
          - n_total_articles: int — total articles across ALL matching
                stories (= sum of n_articles, not just this page).
                Lets the LLM answer "how much coverage on X?" precisely
                without paginating.
          - n_total_distinct_sources: int — distinct sources that
                contributed at least one article to any matching story.
                Use to answer "how many sources reported on this?".
          - has_more: bool — true if more stories remain unfetched
          - next_offset: int | null — pass to a follow-up call
          - user_slug: str
          - filters_applied: dict — echo of the filters used
          - time_window: dict — {from, to} in ISO
          - stories: list of story summaries (see below)

    Each story summary:
        {
          "story_id":           int,
          "label":              str,
          "n_articles":         int,
          "n_distinct_sources": int,           # distinct sources for THIS story
          "first_article_at":   str (ISO),
          "last_article_at":    str (ISO),
          "top_sources": [
            {
              "source":      str,             # source.name
              "feeds":       list[str],        # feed.name(s) for this source on this story
              "n_articles":  int               # articles from this source in the story
            },
            ...                                # capped at 5
          ],
          "n_more_sources":     int,           # 0 if top_sources covers all sources
        }
    """
    # ─── Args validation ───
    if not isinstance(limit, int) or limit <= 0:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    if limit > MAX_LIMIT:
        raise ValueError(f"limit capped at {MAX_LIMIT}, got {limit}")
    if not isinstance(offset, int) or offset < 0:
        raise ValueError(f"offset must be a non-negative integer, got {offset!r}")

    src_country_codes = resolve_country_filter(
        country=source_country, region=source_region,
    )
    subj_country_codes = resolve_country_filter(
        country=subject_country, region=subject_region,
    )

    # Lowercase tokens once. Frontend semantics: case-insensitive.
    norm_query     = (query or "").strip().lower() or None
    norm_keywords  = _normalize_token_list(keywords)
    norm_excluded  = _normalize_token_list(excluded_keywords)

    dt_from, dt_to = _resolve_time_window(time_from, time_to, period_hours)

    # ─── SQL — pull candidate articles with their story/source ───
    # Filters applied at SQL level:
    #   - time window
    #   - the user's feeds
    #   - source country/region (sources.country)
    #   - source langs (items.lang)
    #   - source names / feed names
    #   - subject countries (items.countries jsonb)
    #   - categories / article_types (incl. excludes)
    where_clauses = [
        "a.archive_seed = FALSE",
        "a.title_normalized IS NOT NULL AND TRIM(a.title_normalized) <> ''",
        "COALESCE(a.published_at, a.fetched_at) >= %s",
        "COALESCE(a.published_at, a.fetched_at) <= %s",
        "sa.story_id IS NOT NULL",
    ]
    params: list = [dt_from, dt_to]

    if src_country_codes:
        where_clauses.append("s.country = ANY(%s)")
        params.append(src_country_codes)

    if source_langs:
        where_clauses.append("a.lang = ANY(%s)")
        params.append(source_langs)

    if source_names:
        where_clauses.append("s.name = ANY(%s)")
        params.append(source_names)

    if feed_names:
        where_clauses.append("f.name = ANY(%s)")
        params.append(feed_names)

    if subj_country_codes:
        # items.countries is TEXT json — cast to jsonb and check overlap.
        where_clauses.append("(a.countries::jsonb ?| %s::text[])")
        params.append(subj_country_codes)

    if categories:
        where_clauses.append("(a.category::jsonb ?| %s::text[])")
        params.append(categories)
    if excluded_categories:
        where_clauses.append("NOT (a.category::jsonb ?| %s::text[])")
        params.append(excluded_categories)

    if article_types:
        where_clauses.append("a.article_type = ANY(%s)")
        params.append(article_types)
    if excluded_article_types:
        where_clauses.append("(a.article_type IS NULL OR a.article_type <> ALL(%s))")
        params.append(excluded_article_types)

    # Boolean DSL — parse + compile against the same `a`/`s` aliases
    # the rest of the query uses. AND-combine with the other filters by
    # appending the compiled fragment to where_clauses. Syntax errors
    # surface as ValueError so the LLM gets a clean message rather than
    # a downstream SQL crash.
    if boolean_query and boolean_query.strip():
        try:
            _tree = _parse_boolean(boolean_query)
            _bool_sql, _bool_params = compile_to_where(_tree, alias="a")
        except BooleanQueryError as e:
            raise ValueError(f"boolean_query syntax error: {e}")
        if _bool_sql and _bool_sql != "TRUE":
            where_clauses.append(_bool_sql)
            params.extend(_bool_params)

    # An item reaches the user through any of their monitors that
    # delivered it; DISTINCT ON keeps one row per item, naming the first.
    sql = f"""
        SELECT * FROM (
            SELECT DISTINCT ON (a.id)
                a.id            AS article_id,
                a.title_normalized AS title,
                a.summary_normalized AS summary,
                a.entities,
                a.keywords,
                COALESCE(a.published_at, a.fetched_at) AS published_at,
                sa.story_id,
                st.label        AS story_label,
                f.name          AS feed_name,
                s.name          AS source_name,
                s.country       AS source_country
              FROM items a
              JOIN story_items   sa  ON sa.item_id    = a.id
              JOIN stories       st  ON st.id         = sa.story_id
              JOIN monitor_items mi  ON mi.item_id    = a.id
              JOIN monitors      f   ON f.id          = mi.monitor_id
              JOIN subscriptions sub ON sub.monitor_id = f.id
              JOIN users         u   ON u.id          = sub.user_id
                                    AND u.slug        = %s
              LEFT JOIN sources  s   ON s.id          = a.source_id
             WHERE { ' AND '.join(where_clauses) }
             ORDER BY a.id, mi.fetched_at
        ) matched
         ORDER BY published_at DESC
         LIMIT %s
    """
    params = [current_user_slug(), *params, INTERNAL_ARTICLE_CAP]

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
    finally:
        conn.close()

    # ─── Python — text filters + per-story aggregation ───
    # 1. Apply free-text query / keywords / excluded_keywords per article
    keep_per_article: list[dict] = []
    for r in rows:
        row = {
            "article_id":     r[0],
            "title":          r[1] or "",
            "summary":        r[2] or "",
            "entities":       r[3],
            "keywords":       r[4],
            "published_at":   r[5],
            "story_id":       r[6],
            "story_label":    r[7],
            "feed_name":      r[8],
            "source_name":    r[9],
            "source_country": r[10],
        }
        if norm_query or norm_keywords or norm_excluded:
            haystack = _build_haystack(row)
            if not _article_matches_text(
                haystack, norm_query, norm_keywords, norm_excluded,
            ):
                continue
        keep_per_article.append(row)

    # 2. Group by story_id, accumulate metadata
    by_story: dict[int, dict] = {}
    for row in keep_per_article:
        sid = row["story_id"]
        st = by_story.get(sid)
        if st is None:
            st = {
                "story_id":         sid,
                "label":            row["story_label"],
                "n_articles":       0,
                "first_article_at": row["published_at"],
                "last_article_at":  row["published_at"],
                "by_source":        {},   # source_name → {feeds:set, n_articles}
            }
            by_story[sid] = st

        st["n_articles"] += 1
        if row["published_at"] < st["first_article_at"]:
            st["first_article_at"] = row["published_at"]
        if row["published_at"] > st["last_article_at"]:
            st["last_article_at"] = row["published_at"]

        # Source aggregation
        src_entry = st["by_source"].get(row["source_name"])
        if src_entry is None:
            src_entry = {
                "feeds":      set(),
                "n_articles": 0,
            }
            st["by_source"][row["source_name"]] = src_entry
        src_entry["feeds"].add(row["feed_name"])
        src_entry["n_articles"] += 1

    # 3. Build the final story summaries (sort top_sources, cap, etc.)
    stories_out: list[dict] = []
    for sid, st in by_story.items():
        # Most prolific sources first; name breaks ties so the order is
        # stable from one call to the next.
        sources_sorted = sorted(
            st["by_source"].items(),
            key=lambda kv: (-kv[1]["n_articles"], kv[0]),
        )
        top_sources = []
        for source_name, info in sources_sorted[:MAX_TOP_SOURCES]:
            top_sources.append({
                "source":      source_name,
                "feeds":       sorted(info["feeds"]),
                "n_articles":  info["n_articles"],
            })
        n_more_sources = max(0, len(sources_sorted) - MAX_TOP_SOURCES)

        stories_out.append({
            "story_id":            sid,
            "label":               st["label"],
            "n_articles":          st["n_articles"],
            "n_distinct_sources":  len(st["by_source"]),
            "first_article_at":    st["first_article_at"].isoformat(),
            "last_article_at":     st["last_article_at"].isoformat(),
            "top_sources":         top_sources,
            "n_more_sources":      n_more_sources,
        })

    # 4. Sort stories by last_article_at desc → most recent first
    stories_out.sort(key=lambda s: s["last_article_at"], reverse=True)

    # 5. Pagination + global aggregates (computed BEFORE slicing, so they
    # describe the FULL match set — Claude knows the breadth of the
    # coverage without paginating through every page).
    n_total = len(stories_out)
    n_total_articles = sum(s["n_articles"] for s in stories_out)
    n_total_distinct_sources = len({
        src for st in by_story.values() for src in st["by_source"].keys()
    })

    page = stories_out[offset:offset + limit]
    has_more = (offset + limit) < n_total
    next_offset = (offset + limit) if has_more else None

    # ─── Final response ───
    return {
        "n_stories":                len(page),
        "n_total_matched":          n_total,
        "n_total_articles":         n_total_articles,
        "n_total_distinct_sources": n_total_distinct_sources,
        "has_more":                 has_more,
        "next_offset":              next_offset,
        "user_slug":                current_user_slug(),
        "filters_applied": {
            "boolean_query":          boolean_query,
            "query":                  query,
            "keywords":               keywords,
            "excluded_keywords":      excluded_keywords,
            "source_country":         source_country,
            "source_region":          source_region,
            "subject_country":        subject_country,
            "subject_region":         subject_region,
            "source_langs":           source_langs,
            "source_names":           source_names,
            "feed_names":             feed_names,
            "categories":             categories,
            "excluded_categories":    excluded_categories,
            "article_types":          article_types,
            "excluded_article_types": excluded_article_types,
            "period_hours":           period_hours,
        },
        "time_window": {
            "from": dt_from.isoformat(),
            "to":   dt_to.isoformat(),
        },
        "stories": page,
    }
