"""
Storing what a monitor brought back.

Whatever template fetched them, items go through the same steps:

  1. attribution — the publisher the template named, created in `sources`
     on first sight, or else the monitor's own source;
  2. a deduplication key (`canonical_url`), computed the same way for all;
  3. insertion, one row per canonical key;
  4. one `monitor_items` row per (item, monitor), so an item delivered by
     three monitors is stored once and known to all three.

Strings are cleaned of NUL characters here, at the one place every item
passes through: Postgres refuses them in text as raw bytes and in jsonb
even as the `\\u0000` escape json.dumps turns them into.
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict
from urllib.parse import urlsplit

from psycopg2.extras import execute_values

from src.google_news import canonical_domain, get_or_create_source_by_domain
from src.ingest import canonicalize_url
from src.templates.base import FetchedItem

_COLUMNS = (
    "kind", "source_id", "guid", "title", "url", "canonical_url",
    "published_at", "updated_at",
    "summary", "content", "content_type", "author", "authors", "tags",
    "image_url", "raw_entry", "fetched_at", "archive_seed",
)
_JSON_COLUMNS = {"authors", "tags", "raw_entry"}

_INSERT_BATCH = f"""
    INSERT INTO items ({", ".join(_COLUMNS)})
    VALUES %s
    ON CONFLICT (url) DO NOTHING
    RETURNING id
"""
_INSERT_ONE = f"""
    INSERT INTO items ({", ".join(_COLUMNS)})
    VALUES ({", ".join(f"%({c})s" for c in _COLUMNS)})
    ON CONFLICT (url) DO NOTHING
"""


def store_items(
    cursor,
    monitor: dict,
    items: list[FetchedItem],
    fetched_at: str,
    *,
    first_delivery: bool,
) -> int:
    """Store what one monitor fetched. Returns how many items are new —
    an item another monitor already brought counts 0.

    `first_delivery` is True when the monitor has never delivered anything:
    an undated item from such a monitor is flagged `archive_seed`, kept for
    deduplication and never shown, because nothing tells fresh news from
    the backlog a feed dumps on its first read.
    """
    publishers: dict[str, int | None] = {}
    rows = []
    for item in items:
        row = _row(item, _source_id(cursor, item, monitor, publishers), fetched_at)
        row["archive_seed"] = row["published_at"] is None and first_delivery
        rows.append(row)
    return _insert_and_record(cursor, monitor["id"], rows)


def _source_id(cursor, item: FetchedItem, monitor: dict, cache: dict) -> int | None:
    """The publisher the template named, or the monitor's own."""
    domain = canonical_domain(item.source_domain) if item.source_domain else None
    if not domain:
        return monitor["source_id"]
    if domain not in cache:
        cache[domain] = get_or_create_source_by_domain(
            cursor, domain, item.source_name, auto_created=True,
        )
    return cache[domain] or monitor["source_id"]


def _row(item: FetchedItem, source_id: int | None, fetched_at: str) -> dict:
    fields = _no_nul(asdict(item))
    row = {
        "kind":         fields["kind"],
        "source_id":    source_id,
        "guid":         fields["guid"],
        "title":        fields["title"],
        "url":          fields["url"],
        "published_at": fields["published_at"],
        "updated_at":   fields["updated_at"],
        "summary":      fields["summary"],
        "content":      fields["content"],
        "content_type": fields["content_type"],
        "author":       fields["author"],
        "authors":      fields["authors"],
        "tags":         fields["tags"],
        "image_url":    fields["image_url"],
        "raw_entry":    fields["raw"],
        "fetched_at":   fetched_at,
    }
    row["canonical_url"] = canonical_key(row["url"], row["title"], row["published_at"])
    for column in _JSON_COLUMNS:
        if row[column] is not None:
            row[column] = json.dumps(row[column])
    return row


def canonical_key(url: str, title: str, published_at: str | None) -> str:
    """
    The deduplication key: publisher host, publication minute and
    normalised title when the date is known, the cleaned URL otherwise.

    The content-based key catches what URL-based deduplication misses: one
    piece a publisher hosts at several URLs (BFMTV's "Morning Briefing"
    is both a podcast page and a TV replay page — same title, same minute,
    consecutive ids), and a Google News result with no article URL to
    resolve, reached through several queries, each with its own opaque
    link.

    The host is part of the key, so two publishers running the same wire
    headline at the same minute stay apart: cross-publisher grouping is
    the clusterer's job, on embeddings.

    The title is lower-cased and stripped of punctuation, so encoding
    variants ("&quot;" or '"', double spaces) do not split one piece in
    two. It is not hashed, so the key stays readable in the database.
    Without a date the key would be too coarse — every undated item of a
    host would collapse into one — hence the URL fallback.
    """
    if not published_at:
        return canonicalize_url(url)
    host = urlsplit(url).netloc.lower()
    norm = re.sub(r"[^\w\s]", "", title.lower(), flags=re.UNICODE)
    norm = " ".join(norm.split())[:200]
    return f"content://{host}|{published_at[:16]}||{norm}"


def _no_nul(value):
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, list):
        return [_no_nul(v) for v in value]
    if isinstance(value, dict):
        return {_no_nul(k): _no_nul(v) for k, v in value.items()}
    return value


def _insert_and_record(cursor, monitor_id: int, rows: list[dict]) -> int:
    """Insert the rows whose canonical key is new — once, even when the
    same entry appears twice in one fetch — then record that this monitor
    delivered every one of them."""
    keys = list({r["canonical_url"] for r in rows if r["canonical_url"]})
    if not keys:
        return 0

    cursor.execute("SELECT canonical_url FROM items WHERE canonical_url = ANY(%s)", (keys,))
    known = {row[0] for row in cursor.fetchall()}
    new_rows, seen = [], set()
    for r in rows:
        key = r["canonical_url"]
        if key and key not in known and key not in seen:
            seen.add(key)
            new_rows.append(r)
    n_new = _insert(cursor, new_rows)

    cursor.execute("SELECT id, canonical_url FROM items WHERE canonical_url = ANY(%s)", (keys,))
    item_ids = {key: item_id for item_id, key in cursor.fetchall()}
    deliveries = [
        (item_ids[r["canonical_url"]], monitor_id, r["fetched_at"])
        for r in rows if r["canonical_url"] in item_ids
    ]
    if deliveries:
        execute_values(
            cursor,
            "INSERT INTO monitor_items (item_id, monitor_id, fetched_at) VALUES %s "
            "ON CONFLICT (item_id, monitor_id) DO NOTHING",
            deliveries,
        )
    return n_new


def _insert(cursor, rows: list[dict]) -> int:
    """One round-trip for the batch. Should it fail, the rows go one by one
    and a row that fails alone is skipped, so one bad entry never blocks a
    monitor. Returns how many rows were inserted."""
    if not rows:
        return 0

    cursor.execute("SAVEPOINT items_batch")
    try:
        inserted = execute_values(
            cursor, _INSERT_BATCH,
            [tuple(r[c] for c in _COLUMNS) for r in rows], fetch=True,
        )
        cursor.execute("RELEASE SAVEPOINT items_batch")
        return len(inserted)
    except Exception as e:
        cursor.execute("ROLLBACK TO SAVEPOINT items_batch")
        cursor.execute("RELEASE SAVEPOINT items_batch")
        print(f"  [BATCH-FAIL] {type(e).__name__}: {str(e)[:120]} — falling back to per-row")

    n = 0
    for row in rows:
        cursor.execute("SAVEPOINT one_row")
        try:
            cursor.execute(_INSERT_ONE, row)
            cursor.execute("RELEASE SAVEPOINT one_row")
            n += cursor.rowcount
        except Exception as e:
            cursor.execute("ROLLBACK TO SAVEPOINT one_row")
            cursor.execute("RELEASE SAVEPOINT one_row")
            print(f"  [SKIP] {type(e).__name__} on {row['url'][:60]}: {str(e)[:80]}")
    return n
