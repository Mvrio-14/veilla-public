"""
Google News query support: the helpers behind the `google_news` template.

  - building the RSS URL of a query
  - canonicalising a publisher domain (`lemonde.fr`, not `www.lemonde.fr`)
  - resolving the publisher of a Google News item (its `<source>` tag
    first, the domain of its link otherwise)
  - looking up, or creating, the matching `sources` row

The fetch is the `rss` template's — a Google News RSS URL is standard
RSS (src/templates/google_news). What differs is **attribution per
item**: the publisher comes from the item, not from the monitor.

  - `items.source_id`    = the canonical publisher (Reuters), fixed
  - `monitors.source_id` = NULL for a Google News monitor, which spans
                           publishers
  - `monitor_items`      = which monitors delivered the item
"""
from __future__ import annotations

from urllib.parse import quote_plus, urlsplit

# ── URL builder ──────────────────────────────────────────────────────────


def build_google_news_url(
    query: str,
    hl:    str = "fr",
    gl:    str = "FR",
    ceid:  str | None = None,
) -> str:
    """Construct the RSS URL for a Google News query.

    Args:
        query : boolean query (Google News syntax : `"Novartis"
                AND (pipeline OR "clinical trial")`). URL-encoded here.
        hl    : interface language (ISO 2-letter).
        gl    : geolocation (ISO 2-letter uppercase).
        ceid  : country:language tuple. Defaults to `{gl}:{hl}` if
                omitted — the standard Google News RSS convention.

    Returns:
        Absolute URL string ready for feedparser / requests.
    """
    ceid_val = ceid or f"{gl}:{hl}"
    return (
        "https://news.google.com/rss/search"
        f"?q={quote_plus(query.strip())}"
        f"&hl={hl}"
        f"&gl={gl.upper()}"
        f"&ceid={ceid_val}"
    )


# ── Domain canonicalization ──────────────────────────────────────────────

# Sub-domains publishers typically use for an identical editorial
# mirror. Stripping them yields the same canonical source. Do NOT add
# sub-domains that carry distinct editorial content here —
# `blog.nytimes.com`, `technology.bloomberg.com` and `edition.cnn.com`
# are separate editions, treated as separate sources, with a
# manual merge later if it turns out to matter.
_STRIP_SUBDOMAINS: tuple[str, ...] = (
    "www.",
    "m.",         # mobile subdomain
    "mobile.",
    "amp.",       # AMP mirror
)


def canonical_domain(url_or_domain: str) -> str | None:
    """Return the canonical form of a domain from a URL or bare domain.

    Rules:
      - Parse as URL if it looks like one, else treat as raw domain
      - Lower-case
      - Strip common non-editorial subdomains (`www.`, `m.`, `amp.`)
      - Return None on parse failure or empty input

    Examples:
        canonical_domain("https://www.reuters.com/business/") → "reuters.com"
        canonical_domain("LeMonde.fr")                       → "lemonde.fr"
        canonical_domain("https://blog.nytimes.com/xxx")     → "blog.nytimes.com"
    """
    if not url_or_domain or not isinstance(url_or_domain, str):
        return None

    raw = url_or_domain.strip().lower()
    if not raw:
        return None

    # Accept both `https://foo.com/path` and bare `foo.com`.
    if "://" in raw or raw.startswith("//"):
        netloc = urlsplit(raw).netloc
    else:
        # Bare "foo.com/xxx" — urlsplit needs a scheme to parse netloc
        # correctly, otherwise it puts everything in path.
        netloc = urlsplit(f"//{raw}").netloc

    if not netloc:
        return None

    # Strip port if any ("example.com:8080" → "example.com")
    if ":" in netloc:
        netloc = netloc.split(":", 1)[0]

    # Strip common non-editorial subdomains once (not recursively — we
    # want `www.blog.nytimes.com` → `blog.nytimes.com`, not `nytimes.com`).
    for prefix in _STRIP_SUBDOMAINS:
        if netloc.startswith(prefix):
            netloc = netloc[len(prefix):]
            break  # only strip one layer

    return netloc or None


# ── Per-item source resolution ───────────────────────────────────────────


def extract_publisher_from_entry(entry: dict) -> tuple[str | None, str | None]:
    """Extract the publisher name + canonical domain from a Google News
    RSS entry.

    Priority order (from most reliable to fallback):
      1. `entry.source.href` + `entry.source.title` — Google's own
         canonical mapping. Rare to miss.
      2. Domain of `entry.link` — fallback if <source> tag absent OR
         the link doesn't hide behind a Google redirect. Publisher name
         inferred from netloc (readable-ish).

    Returns:
        (name, canonical_domain) — either or both may be None. When
        both are None the caller MUST attach the article with
        `source_id=NULL` (transient state, can be repaired later by
        an admin backfill).
    """
    src = entry.get("source")
    if isinstance(src, dict):
        href = src.get("href") or ""
        title = (src.get("title") or "").strip() or None
        domain = canonical_domain(href) if href else None
        if domain:
            return (title or domain, domain)

    # Fallback: the link's domain — unless the link is Google's own
    # redirect (news.google.com/rss/articles/...), which says nothing
    # about the publisher.
    link = entry.get("link") or ""
    if link and "news.google.com" not in link:
        domain = canonical_domain(link)
        if domain:
            # Publisher name unknown — derive a placeholder from the
            # domain so the sources row has *some* readable name. Admin
            # can edit later.
            return (domain, domain)

    return (None, None)


def get_or_create_source_by_domain(
    cursor,
    domain: str,
    name:   str | None = None,
    *,
    auto_created: bool = True,
) -> int | None:
    """Look up a `sources` row by canonical domain; create one if absent.

    Called at ingest for each Google News item, once per unique domain
    per batch. The `sources.domain UNIQUE` constraint guarantees no
    duplicates even under concurrent inserts (racy inserts collide on
    the constraint, we catch + re-select).

    Args:
      cursor       : psycopg2 cursor within the current transaction
      domain       : canonical domain (already normalized via
                     `canonical_domain()`)
      name         : display name if the caller has one (from the
                     Google News <source> tag). Falls back to `domain`
                     for the placeholder.
      auto_created : passed to `sources.auto_created`. Default True for
                     the Google News branch — a manually curated source
                     addition goes through /admin/sources with False.

    Returns:
      source_id of the row (existing or fresh), or None if `domain` is
      falsy (defensive — caller should have checked).
    """
    if not domain:
        return None

    cursor.execute("SELECT id FROM sources WHERE domain = %s", (domain,))
    row = cursor.fetchone()
    if row is not None:
        return int(row[0])

    display_name = (name or domain).strip() or domain
    # Insert with ON CONFLICT DO NOTHING against domain — if a concurrent
    # ingest inserted the same domain first, we re-SELECT below to fetch
    # its id.
    from datetime import datetime, timezone
    added_at = datetime.now(timezone.utc).isoformat()
    cursor.execute(
        """
        INSERT INTO sources (name, domain, country, added_at, auto_created)
        VALUES (%s, %s, NULL, %s, %s)
        ON CONFLICT (domain) DO NOTHING
        RETURNING id
        """,
        (display_name, domain, added_at, auto_created),
    )
    row = cursor.fetchone()
    if row is not None:
        return int(row[0])

    # ON CONFLICT DO NOTHING returned no row → someone else inserted
    # concurrently → re-fetch by domain.
    cursor.execute("SELECT id FROM sources WHERE domain = %s", (domain,))
    row = cursor.fetchone()
    return int(row[0]) if row else None
