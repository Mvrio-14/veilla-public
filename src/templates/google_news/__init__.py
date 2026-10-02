"""
The `google_news` template: a Google News search, read as its RSS feed.

    config  {"query", "hl", "gl", "ceid", "url"}   `url` is derived
    cursor  {"etag", "last_modified"}

What sets it apart from a plain feed is that one query spans many
publishers. Each item says which outlet it comes from in its `<source>`
tag, so the template attributes items one by one, links to the article on
the outlet's site rather than Google's redirect, and drops the
" - Outlet" Google appends to every title.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from src.google_news import build_google_news_url, extract_publisher_from_entry
from src.templates.base import FetchResult, Template, TemplateError
from src.templates.rss import (
    MAX_ENTRIES,
    always_empty_warnings,
    conditional_get_cursor,
    entry_to_item,
    fetch_feed,
)


class GoogleNewsTemplate(Template):
    name = "google_news"
    fetch_method = "rss"

    def normalize(self, config: dict) -> dict:
        query = str(config.get("query") or "").strip()
        if not query:
            raise TemplateError("google_news: `query` is required.")
        hl = str(config.get("hl") or "fr").strip().lower()
        gl = str(config.get("gl") or "FR").strip().upper()
        ceid = str(config.get("ceid") or f"{gl}:{hl}").strip()
        return {
            "query": query,
            "hl":    hl,
            "gl":    gl,
            "ceid":  ceid,
            "url":   build_google_news_url(query, hl=hl, gl=gl, ceid=ceid),
        }

    def identity_key(self, config: dict) -> str:
        # The URL encodes the query and its locale, normalised.
        return f"google_news:{config['url']}"

    def fetch(self, config: dict, cursor: dict) -> FetchResult:
        url = config["url"]
        feed = fetch_feed(url, etag=cursor.get("etag"), last_modified=cursor.get("last_modified"))
        # The address is built from the query: a redirect is Google's own
        # business, never a reason to change the config.
        items = [i for i in (self._item(e, url) for e in feed.entries[:MAX_ENTRIES]) if i]
        return FetchResult(
            items=items,
            cursor=conditional_get_cursor(feed),
            not_modified=feed.not_modified,
            warnings=feed.warnings + always_empty_warnings(items),
        )

    @staticmethod
    def _item(entry, feed_url: str):
        # Google's link is an opaque redirect; `<source url>` is the article
        # on the outlet's own site — the URL its own feed carries too, so the
        # same article found both ways is stored once.
        source = entry.get("source")
        if "news.google.com" in (entry.get("link") or "") and isinstance(source, dict) and source.get("href"):
            entry = {**entry, "link": source["href"]}
        item = entry_to_item(entry, feed_url, datetime.now(timezone.utc).isoformat())
        if item is None:
            return None
        item.source_name, item.source_domain = extract_publisher_from_entry(entry)
        item.title = strip_publisher(item.title, item.source_name)
        return item


def strip_publisher(title: str, publisher: str | None) -> str:
    """"Budget adopted - Le Monde" → "Budget adopted". Only the publisher
    the item names is removed, so a title that merely contains a dash
    keeps it."""
    if not publisher:
        return title
    stripped = re.sub(r"\s+[-–|]\s+" + re.escape(publisher) + r"\s*$", "", title, flags=re.IGNORECASE)
    return stripped or title


TEMPLATE = GoogleNewsTemplate()
