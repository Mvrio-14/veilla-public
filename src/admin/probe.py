"""
RSS feed probe — fetch + parse a URL without touching the DB.

Used by the admin "Add feed" flow: the user types a URL, we hit it,
parse it as RSS via feedparser, and return a preview structure so the
UI can show "yes this looks legit, save?" before any DB write.

It runs the `rss` template's own fetch — conditional GET aside — so what
the preview shows is what the worker will get, and adds the diagnostics
an admin wants before saving. Mirrors `scripts/test_feed.py` as a JSON-
serialisable dict for the API. Failures (HTTP error, malformed feed,
empty entries) are NOT exceptions — they come back as a result with
`ok=False` and a human-readable message so the UI can render the
problem inline rather than chewing on a 500.

# Security note

We hit arbitrary user-supplied URLs from the API server. That's a SSRF
risk if anyone other than ADMIN_EMAILS users can call this endpoint —
they could probe internal services (169.254.169.254, etc.). The
`require_admin` dep is the only mitigation; with a sole admin it's
fine. If we ever open admin to more users we add an URL allowlist
(`scheme in (http, https)`, no private CIDR resolution).
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

from src.templates import FetchError, rss


@dataclass
class FieldCoverage:
    """How many entries (out of `total`) carried a non-empty value for
    the named field. Mirror of `scripts/test_feed.py` so the admin UI
    matches what the dev was used to seeing on the CLI."""
    field:   str
    present: int
    total:   int


@dataclass
class SampleEntry:
    """One sample entry's user-facing fields. HTML is stripped from
    summary; long summaries get capped so the UI can render them inline
    without spanning the entire viewport."""
    title:     str
    published: str | None
    summary:   str | None
    image_url: str | None
    source:    str | None      # entry.source.title when present


@dataclass
class ProbeResult:
    ok:           bool
    message:      str
    url:          str
    final_url:    str | None = None   # different from `url` iff redirected
    feed_title:   str | None = None
    feed_lang:    str | None = None
    suggested_source_name: str | None = None
    suggested_source_domain: str | None = None
    n_entries:    int = 0
    detected_type: str | None = None  # "rss" / "atom" / "rdf" — informational
    field_coverage: list[FieldCoverage] = field(default_factory=list)
    unmapped_fields: list[tuple[str, int]] = field(default_factory=list)
    sample_entries: list[SampleEntry] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok":            self.ok,
            "message":       self.message,
            "url":           self.url,
            "final_url":     self.final_url,
            "feed_title":    self.feed_title,
            "feed_lang":     self.feed_lang,
            "suggested_source_name":   self.suggested_source_name,
            "suggested_source_domain": self.suggested_source_domain,
            "n_entries":     self.n_entries,
            "detected_type": self.detected_type,
            "field_coverage": [
                {"field": c.field, "present": c.present, "total": c.total}
                for c in self.field_coverage
            ],
            "unmapped_fields": [
                {"name": name, "count": n} for name, n in self.unmapped_fields
            ],
            "sample_entries": [
                {
                    "title":     e.title,
                    "published": e.published,
                    "summary":   e.summary,
                    "image_url": e.image_url,
                    "source":    e.source,
                }
                for e in self.sample_entries
            ],
        }


def probe_url(url: str) -> ProbeResult:
    """Fetch + parse a URL. Always returns a ProbeResult (no raise)."""
    url = (url or "").strip()
    if not url:
        return ProbeResult(ok=False, message="Empty URL", url=url)

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return ProbeResult(
            ok=False,
            message=f"Unsupported scheme {parsed.scheme!r} — only http/https.",
            url=url,
        )
    if not parsed.hostname:
        return ProbeResult(ok=False, message="URL has no hostname.", url=url)

    # The same fetch the worker will run once the feed is saved.
    try:
        feed = rss.fetch_feed(url)
    except FetchError as e:
        return ProbeResult(ok=False, message=str(e), url=url)

    entries = feed.entries
    if not entries:
        return ProbeResult(
            ok=False,
            message="Feed parsed but has zero entries.",
            url=url,
            final_url=feed.final_url,
        )

    # ── Build preview ────────────────────────────────────────────────
    feed_title = (feed.feed.get("title") or "").strip() or None
    feed_lang  = (feed.feed.get("language") or "").strip() or None
    if feed_lang:
        feed_lang = feed_lang.split("-", 1)[0].lower()  # "en-US" → "en"

    suggested_domain = _derive_domain(feed.final_url or url)
    # Source name suggestion: feedparser exposes feed.publisher or feed.title;
    # neither is reliable as a source name. We use the domain's first label
    # capitalized as a starting point.
    suggested_source_name = _domain_to_source_name(suggested_domain) if suggested_domain else None

    # ── Field coverage (mirrors scripts/test_feed.py) ────────────────
    coverage_fields = ["title", "summary", "published", "author"]
    coverage: list[FieldCoverage] = []
    for f in coverage_fields:
        present = sum(
            1 for e in entries
            if (e.get(f) or "") and str(e[f]).strip()
        )
        coverage.append(FieldCoverage(field=f, present=present, total=len(entries)))
    n_img = sum(1 for e in entries if rss.image_url(e))
    coverage.append(FieldCoverage(field="image", present=n_img, total=len(entries)))

    # ── Fields the template does not read — a useful debug signal ────
    unmapped = Counter(k for e in entries for k in e.keys() if k not in rss.KNOWN_FIELDS)
    unmapped_fields = unmapped.most_common(20)

    # ── Sample entries — sort by parsed date desc, fall back to feed order ─
    def _ts(e):
        return (
            e.get("published_parsed")
            or e.get("updated_parsed")
            or e.get("created_parsed")
        )
    sorted_entries = (
        sorted(entries, key=lambda e: _ts(e) or (), reverse=True)
        if any(_ts(e) for e in entries) else entries
    )
    sample: list[SampleEntry] = []
    for e in sorted_entries[:5]:
        title = (e.get("title") or "").strip() or "(no title)"
        published = (e.get("published") or "").strip() or None
        if published and len(published) > 30:
            published = published[:30]
        # Strip HTML from summary, cap at 200 chars (longer than the CLI
        # because the UI wraps rather than truncating at a fixed width).
        raw_summary = (e.get("summary") or "").strip()
        clean_summary = re.sub(r"<[^>]+>", " ", raw_summary)
        clean_summary = re.sub(r"\s+", " ", clean_summary).strip()
        if len(clean_summary) > 200:
            clean_summary = clean_summary[:200] + "…"
        source_title: str | None = None
        src = e.get("source")
        if isinstance(src, dict):
            source_title = (src.get("title") or "").strip() or None
        sample.append(SampleEntry(
            title=title,
            published=published,
            summary=clean_summary or None,
            image_url=rss.image_url(e),
            source=source_title,
        ))

    return ProbeResult(
        ok=True,
        message=f"Found {len(entries)} entries.",
        url=url,
        final_url=feed.final_url,
        feed_title=feed_title,
        feed_lang=feed_lang,
        suggested_source_name=suggested_source_name,
        suggested_source_domain=suggested_domain,
        n_entries=len(entries),
        detected_type=feed.version,
        field_coverage=coverage,
        unmapped_fields=unmapped_fields,
        sample_entries=sample,
    )


def _derive_domain(url: str) -> str | None:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return None
    if host.startswith("www."):
        host = host[4:]
    return host or None


_GENERIC_SUBDOMAINS = frozenset({
    "news", "rss", "feeds", "feed", "atom", "www", "m", "mobile", "static",
    "cdn", "blog", "blogs",
})


def _domain_to_source_name(domain: str) -> str:
    """Heuristic source name from a domain. Picks the most meaningful
    label rather than always the first one — many sites publish feeds
    from a generic subdomain (`news.bbc.co.uk`, `news.google.com`,
    `feeds.feedburner.com`) that would all collapse to `News` /
    `Feeds` if we naively took `domain.split(".")[0]`.

    Strategy: strip leading generic subdomains, then take the first
    remaining label and capitalize. Examples:
        lemonde.fr            → Lemonde
        news.bbc.co.uk        → Bbc
        news.google.com       → Google
        feeds.feedburner.com  → Feedburner
        www.spiegel.de        → Spiegel

    The result is intentionally a starting suggestion — the admin form
    expects the user to clean it up to the canonical brand name
    (`Bbc` → `BBC`, `Lemonde` → `Le Monde`).
    """
    if not domain:
        return ""
    parts = [p for p in domain.split(".") if p]
    while len(parts) > 1 and parts[0].lower() in _GENERIC_SUBDOMAINS:
        parts = parts[1:]
    if not parts:
        return ""
    label = parts[0]
    return label.capitalize() if label else ""
