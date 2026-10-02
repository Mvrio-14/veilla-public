"""
get_article — full detail of a single article.

Returns everything Veilla knows about one article: identity, source +
feed, all editorial metadata (lang, category, countries,
article_type), entities + keywords extracted by the normalizer, and the
story it belongs to if clustered.

Use this when the user wants the full picture of a specific article
they've seen referenced in a story summary or a search result.
"""
from src.db import get_connection


def _safe_iso(dt) -> str | None:
    return dt.isoformat() if dt is not None else None


def get_article(article_id: int) -> dict:
    """Return the full detail of one article.

    Args:
        article_id: the integer article id, typically obtained from a
            previous `search_stories` → `get_story` call, where each
            article carries its `article_id` field.

    Returns:
        A dict with everything we know about the article. Top-level keys:

        - `article_id`, `title`, `title_normalized`, `summary`,
            `summary_normalized`: the raw RSS fields and the LLM-normalized
            English versions produced by the worker's normalizer step.
        - `url`, `canonical_url`, `image_url`: links + lead image.
        - `author`, `authors`: raw RSS byline (single string or a list of
            `{name, email, href}` dicts depending on the feed's format).
        - `lang`: ISO 639-1 code of the source language.
        - `category`: list of categories (16-bucket Veilla taxonomy).
        - `countries`: list of country codes the article is ABOUT
            (= the normalizer's output, distinct from source country).
        - `article_type`: 'news' / 'feature' / 'opinion' / 'interview' /
            'recap' / 'multimedia' / 'institutional'.
        - `keywords`: list of theme keywords extracted by the normalizer.
        - `entities`: dict with persons / orgs / locations / events /
            markets / products.
        - `published_at`, `fetched_at`: ISO datetimes.
        - `source`: dict with `name`, `domain`, `country`.
        - `feed`: dict with `name`, `url`.
        - `story_id`: the cluster this article belongs to (or None if
            singleton).
        - `archive_seed`: bool. True only for archive backfill rows —
            those are skipped from the regular Watch feed.

    Returns None when no article matches the id.
    """
    if not isinstance(article_id, int) or article_id <= 0:
        raise ValueError(f"article_id must be a positive integer, got {article_id!r}")

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT
                a.id,
                a.title, a.title_normalized,
                a.summary, a.summary_normalized,
                a.url, a.canonical_url, a.image_url,
                a.author, a.authors,
                a.lang, a.category, a.countries,
                a.keywords, a.entities,
                a.article_type,
                a.published_at, a.fetched_at,
                a.archive_seed,
                sa.story_id,
                fm.name AS feed_name, fm.url AS feed_url,
                s.name AS source_name, s.domain AS source_domain, s.country AS source_country
              FROM items a
              LEFT JOIN sources s ON s.id = a.source_id
              LEFT JOIN story_items sa ON sa.item_id = a.id
              -- The monitor that delivered the item first.
              LEFT JOIN LATERAL (
                  SELECT m.name, m.config ->> 'url' AS url
                    FROM monitor_items mi
                    JOIN monitors m ON m.id = mi.monitor_id
                   WHERE mi.item_id = a.id
                   ORDER BY mi.fetched_at
                   LIMIT 1
              ) fm ON TRUE
             WHERE a.id = %s
             LIMIT 1
            """,
            (article_id,),
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if row is None:
        return None

    (
        a_id,
        title, t_norm,
        summary, s_norm,
        url, canonical_url, image_url,
        author, authors,
        lang, category, countries,
        keywords, entities,
        article_type,
        published_at, fetched_at,
        archive_seed,
        story_id,
        feed_name, feed_url,
        source_name, source_domain, source_country,
    ) = row

    return {
        "article_id":            a_id,
        "title":                 title,
        "title_normalized":      t_norm,
        "summary":               summary,
        "summary_normalized":    s_norm,
        "url":                   url,
        "canonical_url":         canonical_url,
        "image_url":             image_url,
        "author":                author,
        "authors":               authors,
        "lang":                  lang,
        "category":              category or [],
        "countries":             countries or [],
        "keywords":              keywords or [],
        "entities":              entities or {},
        "article_type":          article_type,
        "published_at":          _safe_iso(published_at),
        "fetched_at":            _safe_iso(fetched_at),
        "archive_seed":          bool(archive_seed),
        "story_id":              story_id,
        "source": {
            "name":        source_name,
            "domain":      source_domain,
            "country":     source_country,
        },
        "feed": {
            "name": feed_name,
            "url":  feed_url,
        },
    }
