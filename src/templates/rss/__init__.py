"""
The `rss` template: an RSS or Atom feed at a URL.

    config  {"url"}
    cursor  {"etag", "last_modified", "redirect_url", "redirect_seen_count"}

A fetch is a conditional GET — the previous response's validators are sent
back, and a 304 means nothing changed — followed by feedparser on the
body. When the feed answers from another address for
REDIRECT_STABILITY_THRESHOLD fetches in a row, the template asks the
collector to move the monitor there.

The pieces other RSS-based templates reuse — `fetch_feed`,
`entry_to_item`, the field lists — are public; Google News is one.
"""
from __future__ import annotations

import json
import time as _time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone

import feedparser
import requests

from src.ingest import clean_text, fix_bad_host, safe_pub, to_iso
from src.templates.base import (
    FetchedItem,
    FetchError,
    FetchResult,
    Template,
    TemplateError,
)

MAX_ENTRIES = 50                    # safeguard against firehose feeds
FETCH_TIMEOUT = 20                  # seconds, per request (not across redirects)
MAX_BYTES = 5 * 1024 * 1024         # no legitimate feed comes near it
REDIRECT_STABILITY_THRESHOLD = 3    # fetches with the same target before moving

# A browser's User-Agent: some government and institutional sites refuse
# feedparser's and python-requests' own.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
}

# ── Entry fields ────────────────────────────────────────────────────────────
# What `entry_to_item` reads...
MAPPED_FIELDS = {
    "title", "link", "id", "published_parsed", "updated_parsed",
    "summary", "content", "author", "authors", "tags", "media_content", "media_thumbnail",
    # `{href, title}` an aggregator (Google News, Yahoo Finance…) attaches
    # to point at the original article.
    "source",
}

# ...and what it knowingly leaves out. Anything in neither list is logged,
# so that a field worth storing gets noticed.
IGNORED_FIELDS = {
    "title_detail", "summary_detail", "author_detail",
    "guidislink", "links",
    "published", "updated",
    "media_credit", "credit",
    "ismature", "href", "author_url",
    # Recurring noise across the catalogue.
    "media_text",         # caption alt-text (El País, Expansión, …)
    "language",           # feed-level language; the normaliser sets items.lang
    "dcterms_alternative",
    "comments", "wfw_commentrss", "slash_comments",
    "dc_format",
    "post-id",
    "thumbnail",          # alternate to media_thumbnail, already captured
    "media_copyright",
    "purple_isin",        # ISIN ticker (Börsen-Zeitung)
    "foaf_homepage", "rights", "rights_detail",  # The Conversation academic fields
    "surtitre",           # L'Humanité over-title
    "category_id",
}

KNOWN_FIELDS = MAPPED_FIELDS | IGNORED_FIELDS


# ── Fetching ────────────────────────────────────────────────────────────────
@dataclass
class FeedFetch:
    """A feed as downloaded, before its entries become items."""
    entries:       list
    feed:          dict                 # feed-level metadata (title, language…)
    version:       str | None           # "rss20", "atom10"…
    etag:          str | None
    last_modified: str | None
    not_modified:  bool = False
    # The address that answered, when requests followed a redirect to it.
    final_url:     str | None = None
    warnings:      list[str] = field(default_factory=list)


def fetch_feed(url: str, *, etag: str | None = None, last_modified: str | None = None) -> FeedFetch:
    """Download and parse a feed. Raises FetchError on a network error, an
    HTTP error, a body over MAX_BYTES, or a body that is no feed at all.

    `requests` does the HTTP, with an explicit timeout: feedparser's own
    fetcher has none and used to hang a whole worker pass on one slow feed.
    """
    headers = dict(_HEADERS)
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    try:
        response = requests.get(
            url, headers=headers, timeout=FETCH_TIMEOUT,
            allow_redirects=True, stream=True,
        )
        body = _read_capped(response)
    except requests.RequestException as e:
        raise FetchError(f"network: {type(e).__name__}: {e}") from e

    final_url = response.url if (response.history and response.url != url) else None
    etag = response.headers.get("ETag", etag)
    last_modified = response.headers.get("Last-Modified", last_modified)

    if response.status_code == 304:
        return FeedFetch([], {}, None, etag, last_modified,
                         not_modified=True, final_url=final_url)
    if response.status_code != 200:
        raise FetchError(f"HTTP {response.status_code}")

    parsed = feedparser.parse(body, response_headers=dict(response.headers))
    if not parsed.entries and not getattr(parsed, "version", None):
        # A 200 whose body is no feed at all — an HTML page, say. A feed
        # that is merely empty, or served with a wrong content type or
        # charset (feedparser's `bozo`), is a successful fetch.
        reason = getattr(parsed, "bozo_exception", None)
        raise FetchError(f"not a feed: {type(reason).__name__ if reason else 'parse error'}")

    return FeedFetch(
        entries=list(parsed.entries),
        feed=dict(parsed.feed),
        version=getattr(parsed, "version", None) or None,
        etag=etag,
        last_modified=last_modified,
        final_url=final_url,
        warnings=_unmapped_field_warnings(parsed.entries),
    )


def _read_capped(response) -> bytes:
    chunks: list[bytes] = []
    received = 0
    for chunk in response.iter_content(chunk_size=64 * 1024):
        received += len(chunk)
        if received > MAX_BYTES:
            response.close()
            raise FetchError(f"response over {MAX_BYTES // (1024 * 1024)} MB")
        chunks.append(chunk)
    return b"".join(chunks)


def _unmapped_field_warnings(entries: list) -> list[str]:
    unknown = Counter(k for e in entries for k in e.keys() if k not in KNOWN_FIELDS)
    return [f"unmapped field {name!r} in {n} entries" for name, n in unknown.most_common()]


# ── Entries to items ────────────────────────────────────────────────────────
def _json_default(obj):
    if isinstance(obj, _time.struct_time):
        return datetime(*obj[:6], tzinfo=timezone.utc).isoformat()
    return str(obj)


def raw_entry(entry) -> dict:
    """The entry as plain JSON-able data: feedparser's structs become
    ISO dates, anything else unknown becomes its text."""
    return json.loads(json.dumps(dict(entry), default=_json_default))


def image_url(entry) -> str | None:
    """The entry's image. media_thumbnail is always an image; media_content
    can be anything (a YouTube Flash player, say), so it is checked."""
    thumbnail = entry.get("media_thumbnail") or []
    if thumbnail and thumbnail[0].get("url"):
        return thumbnail[0]["url"]
    media = entry.get("media_content") or []
    for m in media:
        if (m.get("type") or "").startswith("image/") and m.get("url"):
            return m["url"]
    if media and media[0].get("url"):
        return media[0]["url"]
    for link in entry.get("links") or []:
        if (link.get("type") or "").startswith("image/"):
            return link.get("href")
    return None


def entry_to_item(entry, feed_url: str, fetched_at: str) -> FetchedItem | None:
    """A feedparser entry as an item, or None when it has no link or no
    title — there is nothing to show for it."""
    raw = raw_entry(entry)

    title = (entry.get("title") or "").strip()
    # feedparser can return a truncated title through .get() when a special
    # character makes the encoding ambiguous ("Michel-Ange"); the raw entry
    # has it whole.
    if len(title.split()) <= 1:
        candidate = (raw.get("title") or "").strip()
        if len(candidate.split()) > len(title.split()):
            title = candidate
    # Entities and stray tags decoded here, or every later step — and the
    # reader — sees `succ&egrave;s`.
    title = clean_text(title) or ""

    url = fix_bad_host(entry.get("link") or "", feed_url)
    if not url or not title:
        return None
    guid_raw = entry.get("id") or entry.get("link") or ""

    content = entry.get("content") or []
    tags = [t.get("term") for t in entry.get("tags") or [] if t.get("term")]

    return FetchedItem(
        url=url,
        title=title,
        published_at=safe_pub(entry.get("published_parsed"), fetched_at),
        updated_at=to_iso(entry.get("updated_parsed")),
        summary=clean_text(entry.get("summary") or entry.get("description")),
        content=clean_text(content[0].get("value")) if content else None,
        content_type=content[0].get("type") if content else None,
        author=entry.get("author"),
        authors=raw.get("authors") or None,
        tags=tags or None,
        image_url=image_url(entry),
        guid=fix_bad_host(guid_raw, feed_url) if guid_raw else None,
        raw=raw,
    )


def items_from(feed: FeedFetch, feed_url: str) -> list[FetchedItem]:
    """The feed's most recent entries as items. Feeds list newest first."""
    fetched_at = datetime.now(timezone.utc).isoformat()
    items = [entry_to_item(e, feed_url, fetched_at) for e in feed.entries[:MAX_ENTRIES]]
    return [i for i in items if i is not None]


def always_empty_warnings(items: list[FetchedItem]) -> list[str]:
    """A field no item of the fetch carries: a feed that never dates its
    entries, say, whose items can never be placed in time."""
    if not items:
        return []
    empty = [f for f in ("summary", "published_at") if not any(getattr(i, f) for i in items)]
    return [f"always empty: {', '.join(empty)}"] if empty else []


def conditional_get_cursor(feed: FeedFetch) -> dict:
    return {
        k: v for k, v in (("etag", feed.etag), ("last_modified", feed.last_modified)) if v
    }


# ── The template ────────────────────────────────────────────────────────────
class RssTemplate(Template):
    name = "rss"
    fetch_method = "rss"

    def normalize(self, config: dict) -> dict:
        url = str(config.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise TemplateError("rss: `url` must be an http(s) address.")
        return {"url": url}

    def identity_key(self, config: dict) -> str:
        return f"rss:{config['url']}"

    def fetch(self, config: dict, cursor: dict) -> FetchResult:
        url = config["url"]
        feed = fetch_feed(url, etag=cursor.get("etag"), last_modified=cursor.get("last_modified"))
        new_cursor, new_config = _follow_redirect(cursor, feed.final_url)
        new_cursor.update(conditional_get_cursor(feed))
        items = items_from(feed, url)
        return FetchResult(
            items=items,
            cursor=new_cursor,
            not_modified=feed.not_modified,
            new_config=new_config,
            warnings=feed.warnings + always_empty_warnings(items),
        )


def _follow_redirect(cursor: dict, final_url: str | None) -> tuple[dict, dict | None]:
    """Track the address the feed answers from, fetch after fetch — a 304
    included, since a moved feed mostly answers "not modified" from its
    new address. Once it has been the same REDIRECT_STABILITY_THRESHOLD
    times in a row, the monitor should move there: the new config is
    returned, with a cursor that starts over.
    """
    if final_url is None:
        return {}, None
    seen = cursor.get("redirect_seen_count", 0) + 1 if cursor.get("redirect_url") == final_url else 1
    if seen >= REDIRECT_STABILITY_THRESHOLD:
        return {}, {"url": final_url}
    return {"redirect_url": final_url, "redirect_seen_count": seen}, None


TEMPLATE = RssTemplate()
