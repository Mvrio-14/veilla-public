"""
create_google_news_query — MCP tool to create a Google News query feed.

A Google News query feed is a catalog entry with the `google_news`
template. Unlike a curated RSS feed, its editorial attribution is per-item at
ingest (extracted from the RSS `<source>` tag) — a single query can
surface content from many publishers (Reuters, Le Monde, blogs, etc.).

This tool lets the agent compose a query in Google News syntax and
create the feed in one shot, with an optional preview to validate the
query before committing.

Design notes :

  - **Preview first** : always call `preview=True` in an initial turn,
    surface the sample items to the user, then confirm and call again
    with `preview=False` to commit. The catalogue is shared, so a new
    feed is confirmed by the user before it is created.

  - **Naming** : the `name` field is user-facing. Choose something
    concise and descriptive ("Novartis pipeline", "AI safety EU").
    Avoid restating the query verbatim.

  - **Google News query syntax** : NOT the same as Veilla's Boolean DSL.
    Google supports AND / OR / NOT, `"phrases"`, `-exclusions`,
    `site:example.com`, `intitle:`. Wildcards, entity: prefix, and
    range dates are NOT supported. Keep queries simple.

  - **After creation** : nobody follows the feed yet, so nothing is
    fetched until it is followed — flagged `starter`, it is followed by
    every new account. The tool returns the fresh slug.
"""

from src.admin import feeds_sources as _fs
from src.admin.feeds_sources import slugify
from src.db import get_connection
from src.templates import FetchError, FetchResult, TemplateError, get_template


def create_google_news_query(
    name:    str,
    query:   str,
    hl:      str  = "fr",
    gl:      str  = "FR",
    ceid:    str | None = None,
    preview: bool = True,
) -> dict:
    """Preview or create a Google News query feed.

    ⚠️ Two-step doctrine :
      1. First call with `preview=True` to inspect the sample items.
      2. Surface the preview to the user, get confirmation.
      3. Second call with `preview=False` to commit.

    Args:
        name    : short user-facing label (e.g. "Novartis pipeline").
        query   : Google News query (basic boolean : AND / OR / NOT /
                  quoted phrases / -exclusions / site: / intitle:).
        hl      : interface language, ISO 639-1 (default 'fr').
        gl      : geolocation, ISO 3166-1 alpha-2 (default 'FR').
        ceid    : country:language tuple (default `{gl}:{hl}`).
        preview : True = do NOT create, return preview. False = create.

    Returns (preview=True):
        {
          "preview":  True,
          "url":      <generated URL>,
          "count":    <items the query returns now, at most 50>,
          "items":    [{title, source_name, source_domain, link, published_at}, ...],
          "warning":  <str | null>,
        }

    Returns (preview=False):
        {
          "preview": False,
          "created": True,
          "feed":    {id, slug, name, url, ...},
        }

    Raises:
        ValueError on invalid input.
        RuntimeError on Google News fetch / parse failures.
    """
    name  = (name  or "").strip()
    query = (query or "").strip()
    if not name:
        raise ValueError("`name` is required (short user-facing label).")
    if not query:
        raise ValueError("`query` is required (Google News boolean syntax).")

    config = {"query": query, "hl": hl, "gl": gl, "ceid": ceid}
    result = _fetch(config)

    # ── Preview path ─────────────────────────────────────────────────
    if preview:
        return _preview_payload(config, result)

    # ── Commit path ──────────────────────────────────────────────────
    # The fetch above is the smoke-test: it raised if Google failed. No
    # items yet is fine — the news the query watches for can come later.

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
                config    = {"query": query, "hl": hl, "gl": gl, "ceid": ceid},
                source_id = None,        # multi-publisher by design
                feed_type = None,
                country   = hl.lower(),  # the content language
            )
        except Exception as e:
            raise RuntimeError(
                f"Could not create feed (probably a duplicate slug or URL): {e}"
            )
        conn.commit()
    finally:
        conn.close()

    return {
        "preview": False,
        "created": True,
        "feed":    feed,
    }


# ── Helpers ─────────────────────────────────────────────────────────


def _fetch(config: dict) -> FetchResult:
    """The `google_news` template's preview of a query — the fetch the
    worker will run once the feed exists."""
    try:
        return get_template("google_news").preview(config)
    except TemplateError as e:
        raise ValueError(str(e))
    except FetchError as e:
        raise RuntimeError(f"Google News fetch failed: {e}")


def _preview_payload(config: dict, result: FetchResult) -> dict:
    """The 5 most recent items, as the agent shows them to the user."""
    items = [
        {
            "title":         item.title,
            "source_name":   item.source_name,
            "source_domain": item.source_domain,
            "link":          item.url,
            "published_at":  item.published_at,
        }
        for item in result.items[:5]
    ]
    warning = None if items else (
        "No items returned. The query may be too narrow, use "
        "unsupported syntax, or have no recent matches. Try "
        "loosening it (fewer AND clauses, drop exclusions)."
    )
    return {
        "preview": True,
        "url":     get_template("google_news").normalize(config)["url"],
        "count":   len(result.items),
        "items":   items,
        "warning": warning,
    }
