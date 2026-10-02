"""
query_sample — pre-flight check for a Boolean DSL query.

Used by the assistant while building a query with the user: run the
`boolean_query` here to get the total match count + a handful of sample
articles. Show the samples to the user, ask them whether the query
captures what they had in mind, then build on it (or adjust it).

Returns a much lighter payload than `search_stories` (no story
clustering, no source aggregations) so the LLM can
iterate quickly without blowing through its context window.

Samples the articles delivered by the feeds of the user named by
VEILLA_MCP_USER_SLUG (see mcp_server/_identity.py).
"""
from datetime import datetime, timedelta, timezone

from mcp_server._identity import current_user_slug
from src.boolean_query import (
    BooleanQueryError,
    compile_to_where,
)
from src.boolean_query import (
    parse as _parse_boolean,
)
from src.db import get_connection

# Same retention horizon as `search_stories` — anything older isn't in
# the DB anyway (pg_cron cleanup).
MAX_PERIOD_HOURS = 336      # 14 days
DEFAULT_PERIOD_HOURS = 168  # 7 days — slightly wider default than
                            # search_stories' 24h. The intent here is
                            # "is this query going to be useful?", and
                            # 24h often returns 0 even on legit queries
                            # (slow-news subject, weekend). 7d gives a
                            # more representative count.

DEFAULT_N_SAMPLES = 5
MAX_N_SAMPLES     = 20

# How much summary text to ship per sample. Keep it short — the LLM
# uses the snippet to judge relevance, not to read the article.
SNIPPET_MAX_CHARS = 240


def query_sample(
    boolean_query: str,
    n:            int = DEFAULT_N_SAMPLES,
    period_hours: int = DEFAULT_PERIOD_HOURS,
) -> dict:
    """Count + sample articles matching a Boolean DSL query.

    The assistant's check before relying on a query. Returns the total
    number of articles that would have matched in the given window, plus
    N light samples (title, source, date, URL, ~240-char snippet).
    Show the samples to the user and confirm the intent.

    Args:
        boolean_query: the Lucene-syntax string to test. Same grammar as
            in `search_stories(boolean_query=…)` — AND/OR/NOT, parens,
            "phrase", `"a b"~N` proximity, and field modifiers (lang:,
            category:, country:, subject_country:, article_type:, feed:,
            entity:Q…, title:, published:[a TO b]). The same string
            always means the same thing across tools.
        n: number of sample articles returned. Default 5, max 20. Pick
            higher when the user wants more confidence; the snippets
            are short so even 20 fits comfortably in context.
        period_hours: rolling lookback from now. Default 168 (= 7 days,
            broad enough to catch slow-news subjects), max 336
            (= 14 days, the catalog retention).

    Returns:
        {
          "boolean_query":     <echoed>,
          "n_total_matches":   <int — count across the whole window>,
          "n_samples_returned": <int — len(samples)>,
          "time_window": {"from": ISO, "to": ISO, "hours": int},
          "samples": [
            {
              "article_id":    <int>,
              "title":         <str>,
              "source":        <str — source.name>,
              "lang":          <ISO 639-1>,
              "published_at":  <ISO>,
              "url":           <str>,
              "snippet":       <str — first ~240 chars of summary>
            },
            ...
          ],
          "user_slug":         <str>,
        }

    Raises:
        ValueError on bad boolean_query syntax (caught from the
        compiler — message points to the column where parsing failed).
        ValueError on out-of-bound n / period_hours.
    """
    # ─── Args validation ───────────────────────────────────────────────
    if not isinstance(boolean_query, str) or not boolean_query.strip():
        raise ValueError(
            "boolean_query must be a non-empty string. To match all "
            "articles in the window, pass '*' or omit the filter side "
            "of this tool entirely (use search_stories instead)."
        )

    if not isinstance(n, int) or n <= 0:
        raise ValueError(f"n must be a positive integer, got {n!r}")
    if n > MAX_N_SAMPLES:
        raise ValueError(f"n capped at {MAX_N_SAMPLES}, got {n}")

    if not isinstance(period_hours, int) or period_hours <= 0:
        raise ValueError(
            f"period_hours must be a positive integer, got {period_hours!r}"
        )
    if period_hours > MAX_PERIOD_HOURS:
        raise ValueError(
            f"period_hours capped at {MAX_PERIOD_HOURS}h (14 days), "
            f"got {period_hours}"
        )

    # ─── Compile the Boolean DSL ───────────────────────────────────────
    try:
        tree = _parse_boolean(boolean_query)
        bool_sql, bool_params = compile_to_where(tree, alias="a")
    except BooleanQueryError as e:
        raise ValueError(f"boolean_query syntax error: {e}")

    # ─── Time window ───────────────────────────────────────────────────
    now = datetime.now(timezone.utc)
    dt_from = now - timedelta(hours=period_hours)
    dt_to   = now

    # ─── Run the count + sample queries ────────────────────────────────
    # Two SQL calls on the same connection: COUNT(*) for the total, then
    # a LIMIT'd SELECT for the samples. Both share the same WHERE so they
    # reflect exactly the same filter set. (We could fold them into one
    # window-function query but two simple statements are easier to
    # read and the count is cheap given the indexes.)
    where_clauses = [
        "a.archive_seed = FALSE",
        "a.title_normalized IS NOT NULL AND TRIM(a.title_normalized) <> ''",
        "COALESCE(a.published_at, a.fetched_at) >= %s",
        "COALESCE(a.published_at, a.fetched_at) <= %s",
    ]
    if bool_sql and bool_sql != "TRUE":
        where_clauses.append(bool_sql)

    where_sql = " AND ".join(where_clauses)

    # `params` for the time window are reused identically in both
    # statements — order matters so we build them once.
    time_params: list = [dt_from, dt_to]
    full_params  = time_params + list(bool_params)

    count_sql = f"""
        SELECT COUNT(DISTINCT a.id)
          FROM items a
          JOIN monitor_items mi  ON mi.item_id     = a.id
          JOIN subscriptions sub ON sub.monitor_id = mi.monitor_id
          JOIN users         u   ON u.id           = sub.user_id
                                AND u.slug         = %s
          LEFT JOIN sources  s   ON s.id           = a.source_id
         WHERE {where_sql}
    """

    sample_sql = f"""
        SELECT DISTINCT ON (a.id)
            a.id,
            COALESCE(a.title_normalized, a.title) AS title,
            COALESCE(a.summary_normalized, a.summary) AS summary,
            a.lang,
            a.url,
            COALESCE(a.published_at, a.fetched_at) AS published_at,
            s.name AS source_name
          FROM items a
          JOIN monitor_items mi  ON mi.item_id     = a.id
          JOIN subscriptions sub ON sub.monitor_id = mi.monitor_id
          JOIN users         u   ON u.id           = sub.user_id
                                AND u.slug         = %s
          LEFT JOIN sources  s   ON s.id           = a.source_id
         WHERE {where_sql}
         ORDER BY a.id, COALESCE(a.published_at, a.fetched_at) DESC
         LIMIT %s
    """

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(count_sql, [current_user_slug(), *full_params])
        n_total = cur.fetchone()[0] or 0

        cur.execute(sample_sql, [current_user_slug(), *full_params, n])
        rows = cur.fetchall()
    finally:
        conn.close()

    samples = []
    for r in rows:
        a_id, title, summary, lang, url, pub_at, src_name = r
        snippet = (summary or "").strip()
        if len(snippet) > SNIPPET_MAX_CHARS:
            snippet = snippet[:SNIPPET_MAX_CHARS].rstrip() + "…"
        samples.append({
            "article_id":   a_id,
            "title":        title or "",
            "source":       src_name,
            "lang":         lang,
            "published_at": pub_at.isoformat() if pub_at else None,
            "url":          url,
            "snippet":      snippet,
        })

    # The samples list above is sorted by article_id (PostgreSQL's
    # DISTINCT ON requires the leading sort key). Re-sort by date so the
    # LLM sees newest first — matches how a human reader scans.
    samples.sort(key=lambda x: x["published_at"] or "", reverse=True)

    return {
        "boolean_query":      boolean_query,
        "n_total_matches":    int(n_total),
        "n_samples_returned": len(samples),
        "time_window": {
            "from":  dt_from.isoformat(),
            "to":    dt_to.isoformat(),
            "hours": period_hours,
        },
        "samples":   samples,
        "user_slug": current_user_slug(),
    }
