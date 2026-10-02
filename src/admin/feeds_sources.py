"""
Admin domain logic for Sources + Feeds.

A "feed" here is a catalog entry (`catalog`): what readers can
follow. Its health — status, failures, last success — belongs to the
public monitor that fetches it, and is read from there. An entry nobody
follows has no monitor yet and reads as active.

Pure DB-level CRUD with the invariants that protect the data model:

  - catalog.slug is UNIQUE → surface a 409 if an edit collides
  - catalog.identity_key is UNIQUE → one entry per URL or query
  - an entry's template and config are validated by src/templates/,
    and its public monitor follows every change to them
  - monitor status — only the admin UI moves `dead → active`
    (= "Resurrect"). The worker is the only writer for
    `active → degraded → dead`.
  - sources.domain is UNIQUE — lookup by domain, never duplicate.

The probe path is read-only and DOES NOT touch DB. It fetches the URL,
parses it as RSS via feedparser, and returns a preview shape the UI can
display ("does this look like the right feed?"). Save is a SECOND, explicit
step.

This module is pure functions over a cursor — no transaction management.
The endpoint handler in api.py owns the conn / commit / rollback so we
can wrap (mutation + audit_log) in a single transaction.
"""
from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlparse

from src.monitors import get_or_create_public_monitor
from src.templates import TemplateError
from src.templates import prepare as prepare_template

# ── Schema constants ─────────────────────────────────────────────────────
# Mirror the CHECK on monitors.status. Defensive: we check on UPDATE rather
# than trusting the caller.
FEED_STATUSES = frozenset({"active", "degraded", "dead"})


# ── Slug generation ──────────────────────────────────────────────────────
def slugify(text: str) -> str:
    """Conservative slug: lowercase, ascii-ish, dashes.

    Not URL-safe in the strictest sense (we don't strip non-ascii
    aggressively — French accents survive as their decomposed form).
    Good enough for catalog identifiers; the unique constraint catches
    collisions either way.
    """
    s = text.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "feed"


def derive_feed_slug(source_name: str | None, feed_name: str, url: str) -> str:
    """Suggest a slug for a new feed. UI shows this then lets the user edit.

    Heuristic: `{source-slug}-{feed-path-or-name}`. Falls back to URL
    pathinfo when feed_name is generic ("RSS feed").
    """
    src_slug  = slugify(source_name or "") or "src"
    feed_slug = slugify(feed_name or "")
    if not feed_slug or feed_slug in {"rss", "feed", "atom", "main"}:
        # Lift the path tail instead so we don't end up with
        # "lemonde-rss" for every feed.
        try:
            path = urlparse(url).path.strip("/")
            feed_slug = slugify(path) or "main"
        except Exception:
            feed_slug = "main"
    return f"{src_slug}-{feed_slug}"


def derive_domain(url: str) -> str:
    """Extract a normalized hostname (no `www.`, lowercase) — used to
    look up an existing `sources` row, or to seed one on the fly."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return ""
    if host.startswith("www."):
        host = host[4:]
    return host


# ── Sources CRUD ─────────────────────────────────────────────────────────
def list_sources(cur) -> list[dict]:
    """Return every source row with a count of its active+degraded feeds.

    `dead` feeds are excluded from the count so the UI's "n_feeds"
    column matches the visible list — dead feeds are still in the
    response when the UI explicitly toggles "show dead" but the count
    summary should match the default view. A feed's status is its public
    monitor's; one without a monitor is alive.
    """
    cur.execute(
        """
        SELECT s.id,
               s.name,
               s.domain,
               s.country,
               s.paywall_policy,
               s.robots_skip,
               s.added_at,
               (
                 SELECT COUNT(*) FROM catalog c
                   LEFT JOIN monitors m ON m.catalog_id = c.id
                  WHERE c.source_id = s.id AND m.status IS DISTINCT FROM 'dead'
               ) AS n_feeds_alive,
               (
                 SELECT COUNT(*) FROM catalog c
                   JOIN monitors m ON m.catalog_id = c.id
                  WHERE c.source_id = s.id AND m.status = 'dead'
               ) AS n_feeds_dead
          FROM sources s
         ORDER BY s.name ASC
        """
    )
    rows = cur.fetchall()
    return [
        {
            "id":             r[0],
            "name":           r[1],
            "domain":         r[2],
            "country":        r[3],
            "paywall_policy": r[4],
            "robots_skip":    bool(r[5]) if r[5] is not None else False,
            "added_at":       r[6].isoformat() if r[6] else None,
            "n_feeds_alive":  int(r[7] or 0),
            "n_feeds_dead":   int(r[8] or 0),
        }
        for r in rows
    ]


def get_source_by_domain(cur, domain: str) -> dict | None:
    cur.execute(
        "SELECT id, name, domain, country, paywall_policy FROM sources WHERE domain = %s",
        (domain.lower(),),
    )
    r = cur.fetchone()
    if not r:
        return None
    return {
        "id":             r[0],
        "name":           r[1],
        "domain":         r[2],
        "country":        r[3],
        "paywall_policy": r[4],
    }


def create_source(
    cur, *, name: str, domain: str, country: str | None,
    paywall_policy: str | None = None, robots_skip: bool = False,
) -> dict:
    """Insert a new source. Caller commits."""
    cur.execute(
        """
        INSERT INTO sources (name, domain, country, paywall_policy, robots_skip, added_at)
        VALUES (%s, %s, %s, %s, %s, NOW())
        RETURNING id, name, domain, country, paywall_policy, robots_skip, added_at
        """,
        (name, domain.lower(), country, paywall_policy, robots_skip),
    )
    r = cur.fetchone()
    return {
        "id":             r[0],
        "name":           r[1],
        "domain":         r[2],
        "country":        r[3],
        "paywall_policy": r[4],
        "robots_skip":    bool(r[5]) if r[5] is not None else False,
        "added_at":       r[6].isoformat() if r[6] else None,
    }


def update_source(
    cur, source_id: int, *,
    name: str | None = None,
    country: str | None = None,
    paywall_policy: str | None = None,
    robots_skip: bool | None = None,
) -> dict | None:
    """Patch-style update: only fields the caller specifies. Returns the
    refreshed row, or None if the source doesn't exist."""
    sets:   list[str] = []
    params: list[Any] = []
    if name           is not None: sets.append("name = %s");           params.append(name)
    if country        is not None: sets.append("country = %s");        params.append(country)
    if paywall_policy is not None: sets.append("paywall_policy = %s"); params.append(paywall_policy)
    if robots_skip    is not None: sets.append("robots_skip = %s");    params.append(robots_skip)
    if not sets:
        # Nothing to update — return the existing row for symmetry.
        cur.execute(
            "SELECT id, name, domain, country, paywall_policy, robots_skip, added_at "
            "FROM sources WHERE id = %s", (source_id,))
    else:
        params.append(source_id)
        cur.execute(
            f"UPDATE sources SET {', '.join(sets)} WHERE id = %s "
            "RETURNING id, name, domain, country, paywall_policy, robots_skip, added_at",
            params,
        )
    r = cur.fetchone()
    if not r:
        return None
    return {
        "id":             r[0],
        "name":           r[1],
        "domain":         r[2],
        "country":        r[3],
        "paywall_policy": r[4],
        "robots_skip":    bool(r[5]) if r[5] is not None else False,
        "added_at":       r[6].isoformat() if r[6] else None,
    }


# ── Feeds CRUD ───────────────────────────────────────────────────────────
_FEED_SELECT = """
    SELECT c.id, c.slug, c.name, c.config ->> 'url', c.feed_type, c.country,
           c.source_id, s.name AS source_name, s.domain, s.country AS source_country,
           COALESCE(m.status, 'active'), COALESCE(m.consecutive_failures, 0),
           m.last_success_at, m.last_failure_at,
           c.added_at, c.starter
      FROM catalog c
      LEFT JOIN monitors m ON m.catalog_id = c.id
      LEFT JOIN sources  s ON s.id = c.source_id
"""


def list_feeds(
    cur, *,
    source_id:    int | None  = None,
    include_dead: bool           = False,
) -> list[dict]:
    """Return every catalog entry, optionally filtered by source / dead status.

    Includes source name + domain inline so the UI can render
    "Le Monde — front" without a per-row JOIN round-trip.
    """
    where:  list[str] = []
    params: list[Any] = []
    if source_id is not None:
        where.append("c.source_id = %s")
        params.append(source_id)
    if not include_dead:
        where.append("m.status IS DISTINCT FROM 'dead'")
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    cur.execute(
        f"{_FEED_SELECT} {where_sql} ORDER BY s.name ASC NULLS LAST, c.name ASC",
        params,
    )
    return [_feed_row_to_dict(r) for r in cur.fetchall()]


def get_feed(cur, feed_id: int) -> dict | None:
    cur.execute(f"{_FEED_SELECT} WHERE c.id = %s", (feed_id,))
    r = cur.fetchone()
    return _feed_row_to_dict(r) if r else None


def create_feed(
    cur, *,
    slug:      str,
    name:      str,
    template:  str,
    config:    dict,
    source_id: int | None,
    feed_type: str | None = None,
    country:   str | None = None,
) -> dict:
    """Insert a new catalog entry. Slug and URL must be unique — the UNIQUE
    constraints surface a clean error to the caller (psycopg2
    IntegrityError → the API layer returns 409).

    `template` is `rss` (config `{url}`) or `google_news` (config
    `{query, hl, gl, ceid}`, with `source_id=None`: the publisher is
    resolved per item at ingest). Raises TemplateError on a bad config.
    """
    _, config, identity_key = prepare_template(template, config)
    cur.execute(
        """
        INSERT INTO catalog (
            slug, name, template, config, identity_key,
            feed_type, source_id, country
        )
        VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            slug, name, template, json.dumps(config), identity_key,
            feed_type, source_id, country,
        ),
    )
    feed_id = cur.fetchone()[0]
    result = get_feed(cur, feed_id)
    assert result is not None  # just-inserted row exists
    return result


def update_feed(
    cur, feed_id: int, *,
    slug:      str | None = None,
    name:      str | None = None,
    url:       str | None = None,
    feed_type: str | None = None,
    country:   str | None = None,
    source_id: int | None = None,
    starter:   bool | None = None,
) -> dict | None:
    """Patch a catalog entry. A new `url` applies to an `rss` entry only
    (TemplateError otherwise); its public monitor, if any, follows."""
    sets:   list[str] = []
    params: list[Any] = []
    if slug      is not None: sets.append("slug = %s");      params.append(slug)
    if name      is not None: sets.append("name = %s");      params.append(name)
    if feed_type is not None: sets.append("feed_type = %s"); params.append(feed_type)
    if country   is not None: sets.append("country = %s");   params.append(country)
    if source_id is not None: sets.append("source_id = %s"); params.append(source_id)
    if starter   is not None: sets.append("starter = %s");   params.append(starter)
    if url is not None:
        cur.execute("SELECT template FROM catalog WHERE id = %s", (feed_id,))
        row = cur.fetchone()
        if row is None:
            return None
        if row[0] != "rss":
            raise TemplateError("Only an RSS feed has an editable URL.")
        _, config, identity_key = prepare_template("rss", {"url": url})
        sets += ["config = %s::jsonb", "identity_key = %s"]
        params += [json.dumps(config), identity_key]
    if not sets:
        return get_feed(cur, feed_id)
    params.append(feed_id)
    cur.execute(
        f"UPDATE catalog SET {', '.join(sets)} WHERE id = %s",
        params,
    )
    if cur.rowcount == 0:
        return None
    sync_public_monitor(cur, feed_id)
    return get_feed(cur, feed_id)


def sync_public_monitor(cur, feed_id: int) -> None:
    """Carry a catalog entry's name, publisher and config over to its
    public monitor.

    A monitor whose config changed is fetching something new: its cursor
    and health start over, since the old address's conditional-GET
    headers and failures say nothing about the new one.
    """
    cur.execute(
        """
        UPDATE monitors m
           SET name      = c.name,
               source_id = c.source_id,
               config    = c.config,
               identity_key = c.identity_key,
               cursor    = CASE WHEN m.identity_key = c.identity_key
                                THEN m.cursor ELSE '{}' END,
               status    = CASE WHEN m.identity_key = c.identity_key
                                THEN m.status ELSE 'active' END,
               consecutive_failures = CASE WHEN m.identity_key = c.identity_key
                                           THEN m.consecutive_failures ELSE 0 END
          FROM catalog c
         WHERE c.id = m.catalog_id
           AND c.id = %s
        """,
        (feed_id,),
    )


def set_feed_status(cur, feed_id: int, status: str) -> dict | None:
    """Move a feed between active / degraded / dead. The admin UI uses
    this to soft-delete (`→ dead`) or resurrect (`→ active`) feeds.

    The status lives on the entry's public monitor, created here if
    nobody follows the entry yet, so that retiring it holds when someone
    does. Resurrect resets the failure counter to 0 so the worker doesn't
    immediately re-mark the monitor dead on the first retry. Soft-delete
    does NOT touch the counter — we want the historical context.
    """
    if status not in FEED_STATUSES:
        raise ValueError(f"status must be one of {sorted(FEED_STATUSES)}, got {status!r}")
    try:
        monitor_id = get_or_create_public_monitor(cur, feed_id)
    except LookupError:
        return None
    if status == "active":
        cur.execute(
            "UPDATE monitors SET status = %s, consecutive_failures = 0 WHERE id = %s",
            (status, monitor_id),
        )
    else:
        cur.execute(
            "UPDATE monitors SET status = %s WHERE id = %s",
            (status, monitor_id),
        )
    return get_feed(cur, feed_id)


# ── Helpers ──────────────────────────────────────────────────────────────
def _feed_row_to_dict(r: tuple) -> dict:
    return {
        "id":                    r[0],
        "slug":                  r[1],
        "name":                  r[2],
        "url":                   r[3],
        "feed_type":             r[4],
        "country":               r[5],
        "source_id":             r[6],
        "source_name":           r[7],
        "source_domain":         r[8],
        "source_country":        r[9],
        "status":                r[10],
        "consecutive_failures":  int(r[11] or 0),
        "last_success_at":       r[12].isoformat() if r[12] else None,
        "last_failure_at":       r[13].isoformat() if r[13] else None,
        "added_at":              r[14].isoformat() if r[14] else None,
        # Subscribed to automatically when an account signs up.
        "starter":               bool(r[15]),
    }
