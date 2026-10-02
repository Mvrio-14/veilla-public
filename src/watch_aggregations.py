"""
Server-side aggregations for the Watch sidebar.

Companion to `src/watch_query.py` (the resolver) and the `/users/{slug}/watch
/aggregations` endpoint. For each facet (entities, countries, categories,
langs, feeds, article_types, scope, quick_filter) this module produces a
COUNT GROUP BY query that runs against the SAME article universe as
`/watch` — but with the per-facet "drill-down" rule applied:

  - Multi-value facets (e.g. categories, entity_persons) DROP their own
    filter before counting. Lets the user always see the other available
    values to re-broaden their pick, mirroring Algolia's behaviour.
  - Mutex facets (scope, quick_filter) KEEP the full QueryState. They
    report counts FOR EACH possible value (all/common/original, all/
    unread/saved/ignored) inside the current filter context — the user
    needs to see "would this filter narrow me to 0?" before clicking.

# Item-level counting

The SPA presents stories and singletons as a single list. The sidebar
counts must match: an item = one row in the user's list (= one story
OR one singleton). A story carrying 5 articles all tagged "Politics"
contributes ONE vote to the Politics facet, not 5. We get this with
`COUNT(DISTINCT item_key)`, where `item_key` collapses all articles of
the same story into a single key. Singletons get their own key per
article (= they ARE the item).

# In-scope filtering

The "in scope" universe = the items delivered by the monitors the user
subscribes to. Identical scoping to `loaders.watch.load_visible_articles`.

# Why a separate module from watch_query.py

The resolver is read-mostly (builds WHERE fragments). This module is
write-once-then-execute (assembles full queries and runs them). Keeping
them apart prevents the resolver from creeping into "query orchestrator"
territory. The contract between the two is the `QueryState` dataclass.
"""
from __future__ import annotations

import threading
import time

from src.languages import PIPELINE_LANGUAGE
from src.watch_query import (
    MAX_PERIOD_HOURS,
    QueryState,
    build_article_where,
    qs_without_facet,
    query_state_from_criteria,
)

# Top-N cap per multi-facet. Beyond this the sidebar truncates and we
# signal `has_more=True` so the SPA can show "Voir tout" instead of
# silently hiding values. 50 covers the realistic newsroom case
# (Politico's top-30 entities of the week + headroom).
TOP_N_PER_FACET = 50


# ── Process-local cache ──────────────────────────────────────────────────
# The 14 facet queries take 2-13s depending on the user's article volume.
# This cache turns repeat aggregations (= same user + same filter set
# within the TTL) into instant responses, which is the common pattern as
# the user navigates / refreshes / has multiple SPA tabs open.
#
# # Scope and invalidation
#
# Per-process (= per Render worker pid). Veilla runs ~1-4 API workers in
# prod, so the same query may miss cache 3x across workers — acceptable
# trade for the simplicity of an in-memory dict over a Redis dependency.
# Worker restart drops everything; new ingest passes don't invalidate
# (the 60s TTL handles staleness — if the worker added 5 articles in
# the last minute, the user sees them on the next refresh).
#
# # Memory bound
#
# `_CACHE_MAX_SIZE` caps the entry count, with naive oldest-eviction
# when full (= ~LRU; full LRU would need an OrderedDict + reorder on
# every hit). 200 entries × ~50 KB/payload = ~10 MB upper bound. Each
# Render API worker has 512 MB RAM — we're a rounding error.
_CACHE_TTL_SEC:   int = 60
_CACHE_MAX_SIZE:  int = 200

_AGGS_CACHE: dict[tuple, tuple[float, dict]] = {}
_AGGS_CACHE_LOCK = threading.Lock()


def _cache_key(
    qs:                QueryState,
    user_id:           str | None,
    scope_monitor_ids: tuple[int, ...],
    output_lang:       str,
) -> tuple:
    # QueryState is a frozen dataclass → hashable. Feeds are normalized
    # to a sorted tuple so order-of-arrival doesn't fragment the cache.
    return (
        hash(qs),
        str(user_id) if user_id else "",
        scope_monitor_ids,
        output_lang,
    )


def _cache_get(key: tuple) -> dict | None:
    now = time.time()
    with _AGGS_CACHE_LOCK:
        cached = _AGGS_CACHE.get(key)
        if cached is None:
            return None
        ts, payload = cached
        if (now - ts) >= _CACHE_TTL_SEC:
            # Expired — best-effort evict to keep the dict bounded.
            _AGGS_CACHE.pop(key, None)
            return None
        return payload


def _cache_put(key: tuple, payload: dict) -> None:
    now = time.time()
    with _AGGS_CACHE_LOCK:
        # Naive bounded eviction: when full, drop the oldest entry by
        # timestamp. O(N) on insertion when capping, irrelevant at
        # N=200.
        if len(_AGGS_CACHE) >= _CACHE_MAX_SIZE:
            oldest = min(_AGGS_CACHE.items(), key=lambda kv: kv[1][0])
            _AGGS_CACHE.pop(oldest[0], None)
        _AGGS_CACHE[key] = (now, payload)


# Facets that DROP their own filter when counting (= drill-down).
# Everything else in `FACETS` keeps the full QS (= mutex semantics).
DRILL_DOWN_FACETS = frozenset({
    "entity_persons",
    "entity_orgs",
    "entity_locations",
    "entity_events",
    "entity_markets",
    "entity_products",
    "categories",
    "subject_countries",
    "source_countries",
    "feeds",
    "langs",
    "article_types",
})


# ── Public API ───────────────────────────────────────────────────────────
def compute_watch_aggregations(
    conn,
    qs:                QueryState,
    user_id:           str | None,
    scope_monitor_ids: list[int],
    output_lang:       str,
    *,
    use_cache:         bool = True,
) -> dict:
    """Compute every sidebar facet count for a /watch query.

    Args:
        conn:             open DB connection
        qs:               the active QueryState (= what the user is looking at)
        user_id:          owner's UUID; pass None for anonymous /watch
                          (= quick_filter aggs are forced to "all" only)
        scope_monitor_ids: the monitors the user subscribes to
        output_lang:      preferred output language (ISO 639-1) — used for
                          the translation-readiness filter in the base CTE,
                          identical to the Watch loader's.

    Returns:
        A dict with one key per facet plus a top-level `total_count`.
        Multi-facets contain `[{value, count, ...}]` lists capped at
        TOP_N_PER_FACET, with a sibling `*_has_more` boolean. Mutex
        facets contain `{value: count, ...}` dicts.

    Performance note: runs 14 queries serially against `conn`. Each is
    ~10-50ms on the GIN/btree indexes of `items`; total
    sits around 200-500ms for the full sidebar refresh. Front debounces
    to 250ms so we never hammer this on every keystroke.

    When `use_cache` is True (default), the result of identical
    (qs, user_id, scope, lang) tuples within `_CACHE_TTL_SEC` is served
    from a process-local cache. Bypass via `use_cache=False` for
    cache-invalidation testing or when freshness matters more than
    latency.
    """
    # ── Cache check (before any DB work) ─────────────────────────────
    cache_key = _cache_key(qs, user_id, tuple(scope_monitor_ids), output_lang)
    if use_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

    out: dict = {}
    cur = conn.cursor()

    # ── Materialize the unfiltered in-scope universe ONCE per request.
    # `_watch_universe` is the article set after the user's feed scope
    # + translation-readiness + archive-seed filters but BEFORE any
    # resolver filters. It's the input every facet query then narrows
    # further. Materializing it as a TEMP TABLE means the 14 facet
    # queries don't re-scan the 30k+ article table 14 times — a single
    # scan feeds them all.
    #
    # ON COMMIT DROP cleans up at the end of the transaction. With
    # psycopg2's default (autocommit=False), a transaction wraps the
    # whole compute and the table dies on the conn.commit() / rollback
    # we trigger before returning. Pool reuse stays clean.
    try:
        cur.execute("DROP TABLE IF EXISTS _watch_universe")
        # Pre-extract JSON sub-arrays at temp-table build time so the 14
        # facet queries below don't each re-parse the same `entities` /
        # `category` / `countries` TEXT columns to JSONB. On a 30k-row
        # candidate set this single pass amortizes ~12 redundant JSONB
        # parses per row across all facets — biggest single perf win
        # in this module.
        #
        # `category` / `countries` / `entities` are
        # native JSONB on `articles` — so we copy them straight through
        # without the legacy `REPLACE(\\u0000, '')::jsonb` wrapper. The
        # NUL-byte defense moved to the producer side (entity_resolver
        # `_canonicalize`, normalizer write path); the migration's
        # cleanup pass already wiped any historical NUL contamination.
        cur.execute(
            """
            CREATE TEMP TABLE _watch_universe ON COMMIT DROP AS
              SELECT DISTINCT a.id           AS article_id,
                     sa.story_id,
                     COALESCE('s'||sa.story_id::text, 'a'||a.id::text) AS item_key,
                     a.lang,
                     a.article_type,
                     s.country  AS source_country,
                     f.name     AS feed_name,
                     COALESCE(a.category,  '[]'::jsonb) AS category_arr,
                     COALESCE(a.countries, '[]'::jsonb) AS countries_arr,
                     COALESCE(a.entities,  '{}'::jsonb) AS entities_jsonb,
                     a.search_vector,
                     COALESCE(a.published_at, a.fetched_at) AS effective_pub,
                     a.archive_seed
                FROM items a
                JOIN monitor_items mi ON mi.item_id = a.id
                JOIN monitors      f  ON f.id = mi.monitor_id
                LEFT JOIN sources  s  ON s.id = a.source_id
                LEFT JOIN story_items sa ON sa.item_id = a.id
               WHERE mi.monitor_id = ANY(%s)
                 AND a.archive_seed = FALSE
                 AND a.title_normalized IS NOT NULL
                 AND TRIM(a.title_normalized) <> ''
                 AND (%s OR a.lang = %s OR a.title_translations ? %s)
                 -- MAX_PERIOD_HOURS cap (30 days). The aggregations are
                 -- always computed over a finite window the SPA's filter
                 -- UI offers (1h..720h max). Materialising every in-scope
                 -- article ever ingested across 91 feeds blows
                 -- past the statement_timeout on /watch/aggregations.
                 -- Uses idx_items_effective_pub.
                 AND COALESCE(a.published_at, a.fetched_at) >= NOW() - (%s::int * INTERVAL '1 hour')
            """,
            (list(scope_monitor_ids), output_lang == PIPELINE_LANGUAGE, output_lang, output_lang,
             MAX_PERIOD_HOURS),
        )
        # No secondary indexes on the temp table: at ~5-10k rows post-
        # scope-filter the planner sequential-scans cheaper than building
        # + traversing an index. ANALYZE so the planner has accurate
        # cardinality estimates for the facet queries that follow.
        cur.execute("ANALYZE _watch_universe")

        # ── Total + mutex facets (use full qs) ─────────────────────────
        out["total_count"]     = _count_total(conn, qs)
        out["by_scope"]        = _count_by_scope(conn, qs)
        out["by_quick_filter"] = _count_by_quick_filter(conn, qs, user_id)

        # ── Multi-facets (drill-down: clear own filter before counting) ─
        # Entity facets route through a dedicated function that JOINs
        # item_entities + entities to return canonical metadata
        # (entity_id, qid, canonical name, country, image_url, …)
        # alongside the count. Non-entity facets still use the JSONB-
        # extract path on `_watch_universe`.
        for facet in DRILL_DOWN_FACETS:
            drill_qs = qs_without_facet(qs, facet)
            if facet.startswith("entity_"):
                values, has_more = _count_entity_facet(conn, drill_qs, facet)
            else:
                values, has_more = _count_multi_facet(conn, drill_qs, facet)
            out[f"by_{facet}"] = values
            out[f"by_{facet}_has_more"] = has_more
    finally:
        # End the transaction → _watch_universe gets dropped via
        # ON COMMIT DROP. Rollback also works (TEMP tables created in
        # an aborted tx never persist), but we commit so subsequent
        # SELECTs on this connection see a clean slate.
        conn.commit()

    # Populate the cache with the freshly-computed payload.
    if use_cache:
        _cache_put(cache_key, out)

    return out


# ── Resolver WHERE adapted to the temp table aliases ─────────────────────
def _build_filter_where(qs: QueryState) -> tuple[str, list]:
    """Build the resolver WHERE adapted to the columns exposed by
    `_watch_universe`. The TEMP TABLE uses bare column names (no `a.`
    prefix) and stores source-side fields as denormalized columns
    (`source_country`, `feed_name`) AND pre-parsed JSONB columns
    (`category_arr`, `countries_arr`, `entities_jsonb`) — so the
    resolver's `f.` / `s.` aliases plus its
    `COALESCE(...)::jsonb` casts need to be remapped to those local
    columns.

    Returns `(sql_fragment, params)` ready to plug into a
    `WHERE <fragment>` clause on `_watch_universe`.
    """
    where, params = build_article_where(
        qs,
        alias="u",
        source_alias="u",
        # Feed and country filters run against the denormalised columns
        # on `_watch_universe` instead of `monitor_items` / `sources s`.
        feed_name_sql      = "u.feed_name",
        source_country_sql = "u.source_country",
    )
    sql = " AND ".join(where)
    # ── Scalar / time aliases ────────────────────────────────────────
    sql = sql.replace(
        "COALESCE(u.published_at, u.fetched_at)",
        "u.effective_pub",
    )
    # The resolver's per-field source-country arm emits `{source_alias}.
    # country = ANY` (we passed "u"). Remap to the denormalised column
    # that `_watch_universe` materialises.
    sql = sql.replace("u.country = ANY", "u.source_country = ANY")
    # ── JSONB columns (pre-extracted at temp-table build time) ───────
    # The resolver still emits the raw-TEXT-to-jsonb cast pattern so it
    # works against the `articles` table directly. On the temp table we
    # already paid that cost once during creation — these replacements
    # swap the cast expressions for the materialized JSONB columns,
    # saving 14× the per-row JSON parse cost across the facet queries.
    # Native JSONB columns — match the pattern
    # `COALESCE(u.col, '[]'::jsonb)` emitted by watch_query.py.
    sql = sql.replace("COALESCE(u.category, '[]'::jsonb)",  "u.category_arr")
    sql = sql.replace("COALESCE(u.countries, '[]'::jsonb)", "u.countries_arr")
    # Entity filters are now EXISTS clauses on `item_entities`
    # The resolver emits `ae.item_id = u.id`, but
    # the temp table's article id column is `article_id` — swap it.
    sql = sql.replace("ae.item_id = u.id", "ae.item_id = u.article_id")
    return sql, params


# ── Total count ──────────────────────────────────────────────────────────
def _count_total(conn, qs: QueryState) -> int:
    """Total visible items (= distinct (story OR singleton) keys)."""
    where_sql, params = _build_filter_where(qs)
    cur = conn.cursor()
    cur.execute(
        f"SELECT COUNT(DISTINCT u.item_key) FROM _watch_universe u WHERE {where_sql}",
        params,
    )
    return int(cur.fetchone()[0])


# ── Scope facet (mutex, 3 buckets: all / common / original) ──────────────
def _count_by_scope(conn, qs: QueryState) -> dict:
    """Counts for the scope tabs (Tous / Communs / Originaux).

    Definitions match what `load_watch` produces at item-build time:
      - common   = item has a story_id AND that story has >= 2 visible
                   articles in scope (after filters)
      - original = item has no story_id, OR its story has only 1 visible
                   article in scope
      - all      = common + original (sanity reference)

    Computed via a window function over the visible-article set rather
    than reading `stories.n_items`, because the latter reflects the
    GLOBAL article count, not the in-scope-after-filter count that the
    SPA actually sees.
    """
    where_sql, params = _build_filter_where(qs)
    sql = f"""
        WITH filtered AS (
            SELECT u.item_key, u.story_id
              FROM _watch_universe u
             WHERE {where_sql}
        ),
        partitioned AS (
            SELECT item_key,
                   story_id,
                   CASE WHEN story_id IS NULL THEN 1
                        ELSE COUNT(*) OVER (PARTITION BY story_id)
                   END AS n_visible
              FROM filtered
        )
        SELECT
            COUNT(DISTINCT item_key)                                                    AS all_count,
            COUNT(DISTINCT item_key) FILTER (WHERE story_id IS NOT NULL AND n_visible >= 2) AS common_count,
            COUNT(DISTINCT item_key) FILTER (WHERE story_id IS NULL OR n_visible < 2)       AS original_count
          FROM partitioned
    """
    cur = conn.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    return {
        "all":      int(row[0] or 0),
        "common":   int(row[1] or 0),
        "original": int(row[2] or 0),
    }


# ── Quick-filter facet (mutex, 4 buckets) ────────────────────────────────
def _count_by_quick_filter(
    conn,
    qs:               QueryState,
    user_id:          str | None,
) -> dict:
    """Counts for the per-user state tabs (All / Unread / Saved /
    Ignored). For anonymous viewers (`user_id is None`) every bucket
    except `all` returns 0.

    Mirrors the user_state logic of `src/loaders/stories.py` exactly:
      - saved    = EXISTS user_story_saves row
      - ignored  = EXISTS user_story_ignores row
      - unread   = NOT EXISTS read row OR read_at < story.latest_pub
                   (story-level — singletons fall back to a story-less
                   read-state heuristic: read iff user_item_reads
                   row exists for that article)
    """
    if user_id is None:
        return {"all": int(_count_total(conn, qs)),
                "unread": 0, "saved": 0, "ignored": 0}

    where_sql, params = _build_filter_where(qs)
    sql = f"""
        WITH filtered AS (
            SELECT u.item_key, u.story_id, u.article_id
              FROM _watch_universe u
             WHERE {where_sql}
        ),
        per_item AS (
            SELECT b.item_key,
                   b.story_id,
                   b.article_id,
                   (uss.story_id IS NOT NULL)                                    AS is_saved,
                   (usi.story_id IS NOT NULL)                                    AS is_ignored,
                   CASE
                     WHEN b.story_id IS NOT NULL THEN
                       (usr.read_at IS NULL OR usr.read_at < st.latest_pub)
                     ELSE
                       (uar.item_id IS NULL)
                   END                                                            AS is_unread
              FROM filtered b
              LEFT JOIN stories st              ON st.id          = b.story_id
              LEFT JOIN user_story_saves   uss  ON uss.story_id   = b.story_id AND uss.user_id = %s
              LEFT JOIN user_story_ignores usi  ON usi.story_id   = b.story_id AND usi.user_id = %s
              LEFT JOIN user_story_reads   usr  ON usr.story_id   = b.story_id AND usr.user_id = %s
              LEFT JOIN user_item_reads uar  ON uar.item_id = b.article_id AND uar.user_id = %s
        )
        SELECT
            COUNT(DISTINCT item_key)                                       AS all_count,
            COUNT(DISTINCT item_key) FILTER (WHERE is_unread  AND NOT is_ignored) AS unread_count,
            COUNT(DISTINCT item_key) FILTER (WHERE is_saved   AND NOT is_ignored) AS saved_count,
            COUNT(DISTINCT item_key) FILTER (WHERE is_ignored)             AS ignored_count
          FROM per_item
    """
    params = params + [user_id, user_id, user_id, user_id]
    cur = conn.cursor()
    cur.execute(sql, params)
    row = cur.fetchone()
    return {
        "all":     int(row[0] or 0),
        "unread":  int(row[1] or 0),
        "saved":   int(row[2] or 0),
        "ignored": int(row[3] or 0),
    }


# ── Multi-value facets (drill-down) ──────────────────────────────────────
def _count_multi_facet(conn, qs: QueryState, facet: str) -> tuple[list[dict], bool]:
    """Compute one multi-value facet's top values (NON-entity facets).

    Returns `(values, has_more)`. `values` is a list of `{value, count}`
    dicts capped at `TOP_N_PER_FACET`. `has_more` is True iff at least
    one more value exists past the cap (the cap+1 query trick).
    """
    where_sql, params = _build_filter_where(qs)
    facet_sql = _facet_value_extractor(facet)
    sql = f"""
        SELECT facet_value AS value, COUNT(DISTINCT u.item_key) AS count
          FROM _watch_universe u
          CROSS JOIN LATERAL ({facet_sql}) AS t(facet_value)
         WHERE {where_sql}
         GROUP BY facet_value
         ORDER BY count DESC, facet_value ASC
         LIMIT %s
    """
    params = params + [TOP_N_PER_FACET + 1]
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    has_more = len(rows) > TOP_N_PER_FACET
    rows = rows[:TOP_N_PER_FACET]
    return (
        [{"value": str(r[0]), "count": int(r[1])} for r in rows if r[0] is not None],
        has_more,
    )


# Maps the aggregations facet name to the `entities.kind` value we
# filter on. Used by `_count_entity_facet` only.
_ENTITY_FACET_TO_KIND = {
    "entity_persons":   "person",
    "entity_orgs":      "org",
    "entity_locations": "location",
    "entity_events":    "event",
    "entity_markets":   "market",
    "entity_products":  "product",
}


def _count_entity_facet(conn, qs: QueryState, facet: str) -> tuple[list[dict], bool]:
    """Compute one entity facet (persons/orgs/locations/events/markets/
    products) by joining item_entities + entities.

    Unlike the JSONB-string path used by other multi-facets, this
    returns the FULL canonical metadata for each entity so the SPA
    sidebar can render avatars / descriptions / country flags without
    a follow-up round-trip.

    Returns `(rows, has_more)`. Each row is:
        {
          entity_id:    int,
          qid:          str | None,     # Wikidata Q-id, NULL if unlinked
          name:         str,            # entities.canonical_label
          kind:         str,            # person / org / ...
          country:      str | None,
          image_url:    str | None,
          description:  str | None,
          count:        int             # distinct item_key count
        }

    Filters out `status != 'active'` rows (merged duplicates and
    tombstoned entries). Follows `cluster_id` indirectly: rows
    flagged 'merged' would never get item_entities pointing at
    them in the first place (the resolver assigns the canonical id),
    so a direct kind+status filter is enough.
    """
    kind = _ENTITY_FACET_TO_KIND.get(facet)
    if kind is None:
        raise ValueError(f"unknown entity facet {facet!r}")

    where_sql, params = _build_filter_where(qs)
    sql = f"""
        SELECT
            e.id,
            e.wikidata_id,
            e.canonical_label,
            e.kind,
            e.country,
            e.image_url,
            e.description,
            COUNT(DISTINCT u.item_key) AS count
        FROM _watch_universe u
        JOIN item_entities ae ON ae.item_id = u.article_id
        JOIN entities         e  ON e.id          = ae.entity_id
        WHERE {where_sql}
          AND e.kind   = %s
          AND e.status = 'active'
        GROUP BY e.id, e.wikidata_id, e.canonical_label, e.kind,
                 e.country, e.image_url, e.description
        ORDER BY count DESC, e.canonical_label ASC
        LIMIT %s
    """
    params = params + [kind, TOP_N_PER_FACET + 1]
    cur = conn.cursor()
    cur.execute(sql, params)
    rows = cur.fetchall()
    has_more = len(rows) > TOP_N_PER_FACET
    rows = rows[:TOP_N_PER_FACET]
    return (
        [{
            "entity_id":   int(r[0]),
            "qid":         r[1],
            "name":        r[2],
            "kind":        r[3],
            "country":     r[4],
            "image_url":   r[5],
            "description": r[6],
            "count":       int(r[7]),
        } for r in rows],
        has_more,
    )


# ── Per-view counts (sidebar "Mes vues" badges) ──────────────────────────
_VIEWS_COUNTS_CACHE: dict[tuple, tuple[float, dict[str, int]]] = {}
_VIEWS_COUNTS_CACHE_LOCK = threading.Lock()


def _views_counts_cache_key(
    user_id:           str,
    scope_monitor_ids: tuple[int, ...],
    output_lang:       str,
    views:             list[dict],
    period_hours:      int,
) -> tuple:
    # Fingerprint each view by its id + criteria-as-JSON + criteria_text
    # so any criteria edit (Panel or Boolean) invalidates the cache
    # automatically. View names / notify flags don't affect counts so
    # they're excluded. criteria_text MUST be in the fingerprint:
    # without it, editing only the Boolean string (criteria stays
    # empty) produces the same fingerprint and returns the stale count.
    import json as _json
    fingerprint = tuple(
        (
            str(v["id"]),
            _json.dumps(v.get("criteria") or {}, sort_keys=True),
            (v.get("criteria_text") or "").strip(),
        )
        for v in views
    )
    return (user_id, scope_monitor_ids, output_lang, fingerprint, period_hours)


def invalidate_views_counts_cache(user_id: str | None = None) -> None:
    """Drop cached views-counts entries. Call after the user CRUDs a view.
    `user_id=None` wipes everything (process-wide), otherwise only the
    target user's entries."""
    with _VIEWS_COUNTS_CACHE_LOCK:
        if user_id is None:
            _VIEWS_COUNTS_CACHE.clear()
            return
        target = str(user_id)
        for key in list(_VIEWS_COUNTS_CACHE.keys()):
            if key[0] == target:
                _VIEWS_COUNTS_CACHE.pop(key, None)


def compute_views_counts(
    conn,
    user_id:           str,
    scope_monitor_ids: list[int],
    output_lang:       str,
    views:             list[dict],
    *,
    use_cache:         bool = True,
    period_hours:      int  = MAX_PERIOD_HOURS,
) -> dict[str, int]:
    """Return `{view_id: item_count}` for the user's saved views.

    Builds ONE in-scope universe temp table sized to `period_hours`
    (the SPA-level period selector, capped by DB retention), then runs
    a small `COUNT(DISTINCT item_key)` per view applying that view's
    `criteria` as a WHERE on top. The per-view cost stays small (~50ms
    on ~5k articles) so even a user with 20 saved views finishes in
    well under a second after the universe build (~2-5s on big users).

    Sharing the universe across views matters: building it once per view
    would put the call into "minutes" territory for the same workload.

    Cache is keyed on `period_hours` too — swapping the SPA dropdown
    recomputes but a repeat call at the same period hits the cache.

    Args:
      conn:             open DB connection (its transaction is committed
                        at the end so the temp table auto-drops)
      user_id:          owner's UUID — folded into the temp-table query
                        for the future `quick_filter` extension; not
                        used directly here but kept in the signature
                        for symmetry with `compute_watch_aggregations`
      scope_monitor_ids: the monitors the user subscribes to
      output_lang:      preferred output language — gates the
                        translation-readiness filter, identical to
                        `compute_watch_aggregations`
      views:            list of dicts shaped like the `/me/views`
                        payload entries (must have `id` and `criteria`
                        keys; `notify`/`name` are ignored here)
      period_hours:     the SPA-level period selector value. Bounds the
                        universe AND the per-view period. Any legacy
                        `periodMinutes` on a view's criteria is ignored
                        (the SPA-level period always wins).
    """
    if not views:
        return {}

    # ── Cache check ──────────────────────────────────────────────────
    cache_key = _views_counts_cache_key(
        user_id, tuple(scope_monitor_ids), output_lang, views, period_hours,
    )
    if use_cache:
        now = time.time()
        with _VIEWS_COUNTS_CACHE_LOCK:
            cached = _VIEWS_COUNTS_CACHE.get(cache_key)
            if cached is not None and (now - cached[0]) < _CACHE_TTL_SEC:
                return cached[1]

    # No views with usable criteria → return zeros for all of them.
    # Skipping the (expensive) temp-table build in this case.
    out: dict[str, int] = {str(v["id"]): 0 for v in views}
    if not scope_monitor_ids:
        return out

    cur = conn.cursor()
    try:
        cur.execute("DROP TABLE IF EXISTS _views_universe")
        # Universe sized to `period_hours` (the SPA-level period). Since
        # every view runs at exactly this period (the SPA-level period
        # always wins), matching the temp table to it is both correct AND
        # cheap — no rows we won't use.
        cur.execute(
            """
            CREATE TEMP TABLE _views_universe ON COMMIT DROP AS
              SELECT DISTINCT a.id           AS article_id,
                     sa.story_id,
                     COALESCE('s'||sa.story_id::text, 'a'||a.id::text) AS item_key,
                     a.lang,
                     a.article_type,
                     s.country  AS source_country,
                     f.name     AS feed_name,
                     -- Native JSONB columns — no REPLACE / cast.
                     COALESCE(a.category,  '[]'::jsonb) AS category_arr,
                     COALESCE(a.countries, '[]'::jsonb) AS countries_arr,
                     COALESCE(a.entities,  '{}'::jsonb) AS entities_jsonb,
                     a.search_vector,
                     COALESCE(a.published_at, a.fetched_at) AS effective_pub,
                     a.archive_seed
                FROM items a
                JOIN monitor_items mi ON mi.item_id = a.id
                JOIN monitors      f  ON f.id = mi.monitor_id
                LEFT JOIN sources  s  ON s.id = a.source_id
                LEFT JOIN story_items sa ON sa.item_id = a.id
               WHERE mi.monitor_id = ANY(%s)
                 AND a.archive_seed = FALSE
                 AND a.title_normalized IS NOT NULL
                 AND TRIM(a.title_normalized) <> ''
                 AND (%s OR a.lang = %s OR a.title_translations ? %s)
                 AND COALESCE(a.published_at, a.fetched_at) >= NOW() - (%s::int * INTERVAL '1 hour')
            """,
            (list(scope_monitor_ids), output_lang == PIPELINE_LANGUAGE, output_lang, output_lang,
             period_hours),
        )
        cur.execute("ANALYZE _views_universe")

        for view in views:
            view_id = str(view["id"])
            try:
                # Build a QueryState from the view's criteria. `period_hours`
                # is forced to the SPA value: any legacy `periodMinutes` in
                # the criteria JSONB is ignored (the SPA-level period wins).
                # `criteria_text` lives in a separate column on `views`
                # — load_user_views exposes it at the
                # top level of the view dict. Forward it explicitly so
                # views composed in Boolean mode actually filter against
                # the compiled Boolean WHERE instead of falling back to
                # the (empty) per-field criteria.
                qs = query_state_from_criteria(
                    view.get("criteria") or {},
                    default_period_hours=period_hours,
                    criteria_text=view.get("criteria_text"),
                )
                where_sql, params = _build_filter_where(qs)
                cur.execute(
                    f"SELECT COUNT(DISTINCT u.item_key) FROM _views_universe u WHERE {where_sql}",
                    params,
                )
                out[view_id] = int(cur.fetchone()[0])
            except Exception as e:
                # A single broken view shouldn't sink the whole batch;
                # log and surface 0 so the SPA shows a falsy badge.
                print(f"[views_counts] view {view_id}: {e}", flush=True)
                out[view_id] = 0
    finally:
        conn.commit()

    # Populate cache for the next call within the TTL.
    if use_cache:
        now = time.time()
        with _VIEWS_COUNTS_CACHE_LOCK:
            if len(_VIEWS_COUNTS_CACHE) >= _CACHE_MAX_SIZE:
                oldest = min(_VIEWS_COUNTS_CACHE.items(), key=lambda kv: kv[1][0])
                _VIEWS_COUNTS_CACHE.pop(oldest[0], None)
            _VIEWS_COUNTS_CACHE[cache_key] = (now, out)

    return out


def _facet_value_extractor(facet: str) -> str:
    """Return a SQL fragment that, given a row of `_watch_universe u`,
    emits the per-facet value(s) for that article. Wrapped by the caller
    in `CROSS JOIN LATERAL (...) AS t(facet_value)`.

    Reads from the pre-parsed `*_arr` JSONB columns materialized at
    temp-table build time — no per-row JSON parsing here.
    """
    # Scalar facets — single value per article.
    if facet == "langs":
        return "SELECT u.lang WHERE u.lang IS NOT NULL"
    if facet == "article_types":
        return "SELECT u.article_type WHERE u.article_type IS NOT NULL"
    if facet == "source_countries":
        return "SELECT u.source_country WHERE u.source_country IS NOT NULL"
    if facet == "feeds":
        return "SELECT u.feed_name WHERE u.feed_name IS NOT NULL"

    # JSON-array facets — unnest the pre-parsed JSONB column.
    if facet == "categories":
        return "SELECT jsonb_array_elements_text(u.category_arr)"
    if facet == "subject_countries":
        return "SELECT jsonb_array_elements_text(u.countries_arr)"

    # Entity facets are NOT handled here — they go through
    # `_count_entity_facet` which joins item_entities + entities
    # for canonical Q-id resolution. The caller in
    # `compute_watch_aggregations` routes by facet name. If we land
    # here for an entity facet, that's a bug in the caller's routing.
    if facet in ("entity_persons", "entity_orgs", "entity_locations",
                 "entity_events", "entity_markets", "entity_products"):
        raise ValueError(
            f"entity facet {facet!r} must be routed through "
            f"_count_entity_facet, not _facet_value_extractor"
        )

    raise ValueError(f"unknown facet {facet!r}")
