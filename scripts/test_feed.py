"""
Test a feed URL before adding it to the catalog.

Usage:
    python scripts/test_feed.py <url>
    python scripts/test_feed.py https://www.france24.com/fr/economie/rss
"""
import io
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.path.insert(0, str(Path(__file__).parent.parent))

import feedparser
import requests

from src.templates.rss import KNOWN_FIELDS

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}


def fetch_feed(url: str):
    """Fetch feed with feedparser; fallback to requests if User-Agent is blocked."""
    feed = feedparser.parse(url)
    status = feed.get("status", "N/A")
    if status == "N/A" or (status != 200 and not feed.entries):
        r = requests.get(url, headers=_BROWSER_HEADERS, timeout=15)
        feed = feedparser.parse(r.content, response_headers=dict(r.headers))
        feed["status"] = r.status_code
        if r.status_code == 200:
            print("  [note] feedparser blocked — retried with browser User-Agent")
    return feed


N_SAMPLE = 5


def check_field(entries: list, field: str) -> tuple[int, int]:
    """Return (count_with_value, total)."""
    n = sum(1 for e in entries if e.get(field) and str(e[field]).strip())
    return n, len(entries)


def get_image(entry) -> str | None:
    thumbnail = entry.get("media_thumbnail") or []
    media     = entry.get("media_content") or []
    if thumbnail:
        return thumbnail[0].get("url")
    media_image = next(
        (m.get("url") for m in media if (m.get("type") or "").startswith("image/")),
        None,
    )
    if media_image:
        return media_image
    if media:
        return media[0].get("url")
    # Fallback: look for image in enclosures
    for link in entry.get("links", []):
        if (link.get("type") or "").startswith("image/"):
            return link.get("href")
    return None


def coverage_icon(n, total) -> str:
    ratio = n / total if total else 0
    if ratio >= 0.9:  return "✓"
    if ratio >= 0.4:  return "~"
    return "✗"


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    url = sys.argv[1]
    print(f"\nFetching : {url}")
    print("-" * 60)

    try:
        feed = fetch_feed(url)
    except Exception as e:
        print(f"[ERROR] Could not fetch feed: {e}")
        sys.exit(1)

    status = feed.get("status", "N/A")
    if status == 301:
        print("[REDIRECT] HTTP 301 — feed moved permanently, feedparser followed redirect")
    elif status != 200:
        print(f"[DEAD]  HTTP {status} — feed unreachable")
        sys.exit(1)

    entries = feed.entries
    n       = len(entries)

    feed_type  = feed.feed.get("type") or feed.version or "unknown"
    feed_title = feed.feed.get("title", "")

    print(f"Status  : {status} OK")
    print(f"Type    : {feed_type}")
    print(f"Title   : {feed_title}")
    print(f"Entries : {n}")

    if n == 0:
        print("\n[WARN] Feed is empty — no entries found.")
        sys.exit(0)

    # Field coverage
    fields = ["title", "summary", "published", "author"]
    print(f"\nField coverage ({n} entries):")
    for field in fields:
        count, total = check_field(entries, field)
        icon = coverage_icon(count, total)
        print(f"  {field:<12} {count:>3}/{total}  {icon}")

    # Image coverage (custom logic)
    n_img = sum(1 for e in entries if get_image(e))
    icon  = coverage_icon(n_img, n)
    print(f"  {'image':<12} {n_img:>3}/{n}  {icon}")

    # Unmapped / extra fields (the rss template's KNOWN_FIELDS — single source of truth)
    from collections import Counter
    unmapped = Counter()
    for e in entries:
        for k in e.keys():
            if k not in KNOWN_FIELDS:
                unmapped[k] += 1
    if unmapped:
        print(f"\nUnmapped fields ({len(unmapped)} unique, not read by the rss template):")
        for field, count in unmapped.most_common():
            print(f"  {field:<30} {count:>3}/{n}")

    # Sample entries — force most recent first (feedparser's order isn't
    # guaranteed; some feeds publish chronologically ascending). Falls
    # back to the original order when no parsed date is available.
    def _entry_ts(e):
        return (
            e.get("published_parsed")
            or e.get("updated_parsed")
            or e.get("created_parsed")
        )
    entries_sorted = sorted(
        entries,
        key=lambda e: _entry_ts(e) or (),
        reverse=True,
    ) if any(_entry_ts(e) for e in entries) else entries

    print(f"\nSample ({min(N_SAMPLE, n)} most recent entries):")
    print("-" * 60)
    for i, e in enumerate(entries_sorted[:N_SAMPLE]):
        title     = e.get("title", "(no title)")
        published = e.get("published", "")[:16]
        summary   = (e.get("summary") or "")
        # strip HTML tags from summary
        import re
        summary = re.sub(r"<[^>]+>", "", summary).strip()[:120]
        image    = get_image(e)
        img_str  = "img: ✓" if image else "img: ✗"

        print(f"\n  {i+1}. {title}")
        print(f"     {published}  |  {img_str}")
        if summary:
            print(f"     {summary}...")
        if e.get("source"):
            src = e["source"]
            if isinstance(src, dict) and src.get("title"):
                print(f"     source: {src['title']}")

    print()


if __name__ == "__main__":
    main()
