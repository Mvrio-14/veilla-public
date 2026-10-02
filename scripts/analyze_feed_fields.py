"""
Diagnose feed fields we don't extract.

For every monitor, sample recent items (raw_entry JSON), enumerate
every key present, and report those we DON'T map to a DB column.
Sorted by # of feeds using each — frequent ones first.

Two buckets:
  - IGNORED fields: declared in templates.rss.IGNORED_FIELDS (we know about
    them, decided not to store). Marked `[ignored]` — review periodically.
  - UNKNOWN fields: not in any list. Marked `[unknown]` — strongest
    candidates for adding to MAPPED_FIELDS or IGNORED_FIELDS explicitly.

Usage:
    python -m scripts.analyze_feed_fields
    python -m scripts.analyze_feed_fields --sample 100   # default 50
"""
from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.db import get_connection
from src.templates.rss import IGNORED_FIELDS, MAPPED_FIELDS  # noqa: E402

SAMPLE_DEFAULT = 50


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", type=int, default=SAMPLE_DEFAULT,
                        help=f"Items sampled per monitor (default {SAMPLE_DEFAULT})")
    args = parser.parse_args()

    conn = get_connection()
    cur  = conn.cursor()

    # field_name -> set of monitor names that expose it
    field_to_feeds: dict[str, set[str]] = defaultdict(set)

    cur.execute("SELECT id, name FROM monitors ORDER BY id")
    monitors = cur.fetchall()

    for monitor_id, label in monitors:
        cur.execute(
            "SELECT i.raw_entry FROM items i "
            "JOIN monitor_items mi ON mi.item_id = i.id "
            "WHERE mi.monitor_id = %s "
            "ORDER BY i.fetched_at DESC LIMIT %s",
            (monitor_id, args.sample),
        )
        for (entry,) in cur.fetchall():
            if not isinstance(entry, dict):
                continue
            for key, value in entry.items():
                if key in MAPPED_FIELDS:
                    continue
                # Items stored before the templates carry `_feed_name`, a
                # tag the old collector added. It is not feed-supplied.
                if key.startswith("_"):
                    continue
                if value is None or (isinstance(value, (str, list, dict)) and not value):
                    continue
                field_to_feeds[key].add(label)

    if not field_to_feeds:
        print("No unmapped fields found — every populated key in raw_entry is in MAPPED_FIELDS.")
        return

    # Sort by # of feeds desc, then alpha
    rows = sorted(field_to_feeds.items(), key=lambda kv: (-len(kv[1]), kv[0]))

    print("Fields populated in raw_entry but NOT in templates.rss.MAPPED_FIELDS")
    print(f"(sampled up to {args.sample} items per monitor across {len(monitors)} monitors)")
    print()
    for field, feeds_set in rows:
        tag = "[ignored]" if field in IGNORED_FIELDS else "[unknown]"
        feeds_list = sorted(feeds_set)
        if len(feeds_list) <= 8:
            feed_str = ", ".join(feeds_list)
        else:
            feed_str = ", ".join(feeds_list[:8]) + f", +{len(feeds_list) - 8} more"
        print(f"  {tag}  {field:<28}  ({len(feeds_set):>2} feeds)  {feed_str}")

    conn.close()


if __name__ == "__main__":
    main()
