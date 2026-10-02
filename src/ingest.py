"""
Ingest-level cleanup helpers — prep raw feedparser data for insertion.

Centralized here (rather than scattered between `collector.py` and
`normalizer.py`) so additions can be made + tested in one place.
Importers should treat these as pure functions: stateless, side-effect
free, safe to call repeatedly.

RSS ingest hygiene. The split:
  - `clean_text`               : strip HTML entities + tags from a text field
  - `clean_title_attribution`  : strip " - Source" from a title
  - `canonicalize_url`         : normalize a URL for duplicate detection
  - `fix_bad_host`             : rewrite localhost article links to the feed host
  - `to_iso` + `safe_pub`      : convert feedparser's struct_time to ISO,
                                  guarding against feeds that publish into the future
"""
from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import (
    parse_qsl,
    urlencode,
    urlparse,
    urlsplit,
    urlunparse,
    urlunsplit,
)

from bs4 import BeautifulSoup

# ── HTML cleanup ────────────────────────────────────────────────────────────
# BeautifulSoup's `lxml` parser would be faster but adds a system-level
# dependency (libxml2). The pure-Python `html.parser` is bundled with
# Python and fast enough for our RSS volume (a few hundred entries per
# pass, each ≤ a few KB of HTML). We can switch to `lxml` later if the
# collect duration shows it as a bottleneck.
_BS_PARSER = "html.parser"

# Tags whose entire content should be DROPPED, not just unwrapped. A
# regex `<[^>]+>` strip leaves the inner text behind, which polluted
# summaries with CSS/JS from feeds that embed style/script tags
# (rare but happens on some institutional feeds).
_DROP_TAGS = ("script", "style", "noscript", "iframe", "object", "embed")


def clean_text(s: str | None) -> str | None:
    """Decode HTML entities and strip HTML tags from a feed display field.

    Returns None when input is None or empty. Idempotent: calling twice
    is a no-op (entities already decoded won't change, tags already
    stripped stay gone).

    Uses BeautifulSoup so we handle:
      - All HTML named + numeric entities (`&egrave;`, `&#233;`, etc.)
        via the underlying parser
      - `<script>` / `<style>` / `<iframe>` content dropped (= the
        regex-strip we used before left CSS/JS in the output)
      - Lists rendered with separators (`<ul><li>a</li><li>b</li></ul>`
        → "a b" instead of "ab")
      - `<br>` / `<p>` / block elements separated by single spaces
        instead of glued together

    For trivial inputs (no `<` character) we short-circuit to a plain
    `html.unescape` to avoid the BeautifulSoup parser overhead on the
    common case (most RSS titles are entity-only, no markup).
    """
    if not s:
        return s

    # Fast path: no HTML markup at all → just decode entities.
    if "<" not in s:
        return html.unescape(s).strip()

    soup = BeautifulSoup(s, _BS_PARSER)

    # Remove tags whose content we don't want (script, style, etc.) BEFORE
    # extracting text — get_text would otherwise include their inner text.
    for tag in soup.find_all(_DROP_TAGS):
        tag.decompose()

    # `separator=" "` inserts a space between sibling tags so lists and
    # adjacent <p> blocks stay readable. `strip=True` trims each text
    # node before joining.
    text = soup.get_text(separator=" ", strip=True)

    # Final whitespace collapse (multiple separators can stack).
    text = re.sub(r"\s+", " ", text).strip()
    return text


# ── Title attribution stripping ─────────────────────────────────────────────
def clean_title_attribution(title: str, source_name: str | None) -> str:
    """Strip the source's own name from a title or summary: a trailing
    " - Source" or " | Source", or a leading "Source - ".

    Matched against `source_name`, case-insensitively, so a title that
    merely contains a dash keeps it. Google News titles have their
    publisher removed by their template when they are fetched.
    """
    if not title or not source_name:
        return title

    # Strip trailing " - Source" or " | Source"
    pattern = r"\s*[-–|]\s*" + re.escape(source_name) + r"\s*$"
    title = re.sub(pattern, "", title, flags=re.IGNORECASE).strip()

    # Strip leading "Source - " or "Source | "
    pattern = r"^" + re.escape(source_name) + r"\s*[-–|]\s*"
    title = re.sub(pattern, "", title, flags=re.IGNORECASE).strip()

    return title


# ── URL canonicalisation ────────────────────────────────────────────────────
# Tracking / analytics query params we strip from URLs before checking for
# duplicates. Same article syndicated through 2 feeds typically differs only
# in these — without this list the collector would happily insert N rows for
# the same canonical content.
_TRACKING_PARAMS = {
    # Google / common
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "utm_id", "utm_name", "utm_referrer", "_ga", "_gl", "fbclid", "gclid",
    "msclkid", "yclid", "dclid", "mc_cid", "mc_eid",
    # Newsroom / wire-specific
    "ref", "ref_src", "rec_id", "rss_id", "rss",
    "feature", "mod",                      # WSJ
    "cmpid", "cmp", "cid",                 # CNBC, FT
    "srnd", "sref",                        # Bloomberg
    "leadSource", "leadsource",
    # Yahoo et al.
    "guccounter", "guce_referrer", "guce_referrer_sig",
    # Misc tracking
    "smid", "smtyp", "ftcamp", "_fbp",
}


def canonicalize_url(url: str) -> str:
    """Return a canonical form of `url` for duplicate detection.

    - lowercase scheme + host (paths and query keys are case-sensitive on
      most servers, leave them alone)
    - drop the fragment (`#...`) — never sent to servers
    - drop tracking query params (`utm_*`, `fbclid`, `srnd`, …)
    - drop a single trailing slash if the path isn't just "/"
    - keep everything else verbatim — paths and remaining query params can
      be load-bearing for the article URL to resolve.

    Returns the lowercased trimmed URL on parse failure rather than raising
    — collector dedup is best-effort, never a hard fail.
    """
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
        scheme = parts.scheme.lower()
        netloc = parts.netloc.lower()

        path = parts.path or ""
        if len(path) > 1 and path.endswith("/"):
            path = path[:-1]

        if parts.query:
            kept = [
                (k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                if k.lower() not in _TRACKING_PARAMS
            ]
            query = urlencode(kept) if kept else ""
        else:
            query = ""

        return urlunsplit((scheme, netloc, path, query, ""))
    except Exception:
        return url.lower().strip()


# ── Bad-host fixup ──────────────────────────────────────────────────────────
_BAD_HOSTS = {"localhost", "127.0.0.1"}
# Module-level memo: one warn line per offending feed instead of one per
# article, so a misconfigured publisher doesn't drown the logs.
_HOST_FIX_WARNED: set[str] = set()


def fix_bad_host(url: str, feed_url: str) -> str:
    """If `url`'s host is localhost/127.0.0.1 (a publisher RSS bug),
    substitute the feed's host while keeping path/query/fragment. No-op
    for valid URLs.
    """
    if not url or not feed_url:
        return url
    try:
        u = urlparse(url)
        if (u.hostname or "").lower() not in _BAD_HOSTS:
            return url
        feed = urlparse(feed_url)
        if not feed.netloc:
            return url
        if feed_url not in _HOST_FIX_WARNED:
            _HOST_FIX_WARNED.add(feed_url)
            print(
                f"[HOST-FIX] {feed_url} - article links use "
                f"'{u.hostname}', rewriting to '{feed.hostname}'"
            )
        return urlunparse(
            (feed.scheme or "https", feed.netloc, u.path, u.params, u.query, u.fragment)
        )
    except Exception:
        return url


# ── Date utils ──────────────────────────────────────────────────────────────
# Tolerance for clock skew between RSS server and our machine. If a feed
# declares a pub date more than this far in the future relative to the
# moment we fetched the article, we treat the pub date as missing (NULL)
# and let downstream COALESCE(published_at, fetched_at) fall back to the
# fetch time. Some feeds (Handelsblatt, Jeune Afrique) publish scheduled
# / pre-dated items where the declared pub is hours or days ahead of when
# the item actually appears in their RSS — using that future timestamp
# would mislabel the article and inflate stories.latest_pub.
_FUTURE_PUB_TOLERANCE = timedelta(minutes=5)


def to_iso(struct_time) -> str | None:
    """feedparser's *_parsed struct_time → tz-aware ISO 8601 string in UTC."""
    if struct_time is None:
        return None
    return datetime(*struct_time[:6], tzinfo=timezone.utc).isoformat()


def safe_pub(struct_time, fetched_at_iso: str) -> str | None:
    """ISO publication date, or None if it's meaningfully ahead of
    `fetched_at_iso` (= the feed is scheduling future items)."""
    pub_iso = to_iso(struct_time)
    if not pub_iso:
        return None
    try:
        pub_dt   = datetime.fromisoformat(pub_iso)
        fetch_dt = datetime.fromisoformat(fetched_at_iso)
        if pub_dt > fetch_dt + _FUTURE_PUB_TOLERANCE:
            return None
    except (ValueError, TypeError):
        # Malformed dates: keep the original value, downstream handles it.
        pass
    return pub_iso
