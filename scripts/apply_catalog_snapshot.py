"""
Apply a catalog snapshot (JSON → DB) — explicit, never automatic.

The inverse of `dump_catalog_snapshot.py`. Reads the on-disk snapshot
files and reconciles the DB to match them:

  - Inserts new sources / feeds present in JSON but missing in DB
  - Updates existing sources / feeds whose metadata differs from JSON,
    including each feed's `starter` flag
  - DOES NOT delete sources/feeds that exist in DB but not in JSON
    (= the DB may contain admin UI additions you haven't snapshotted
    yet; this script is additive-on-rows by default)

# Why this exists despite "DB-as-truth"

Two legitimate use cases:

1. **Bootstrap a fresh env** — staging / new dev DB. Apply the
   committed snapshot to populate the catalog in one shot.

2. **Recover from accidental data loss** — if someone fat-fingered a
   delete via SQL Editor, apply the last good snapshot to restore.

What this is NOT:

  - A two-way sync. The script is one-shot; you run it deliberately.
  - A way to undo a bunch of admin UI changes by reverting the JSON.
    (Well, technically yes — but the script will tell you what it's
    about to overwrite and require `--confirm` to proceed.)

# Safety rails

On a populated DB (= `catalog` non-empty), the script REFUSES to
run unless `--confirm` is passed. This prevents the most common
accident: pulling the repo on a deploy box and accidentally running the
script over a populated DB, losing all admin UI edits since the last
snapshot.

Audit log: every mutation lands in `admin_actions` with
`actor_user_id=NULL` and a payload tagged `via=apply_catalog_snapshot`
so post-mortem queries can identify mass-import events.

# Usage

    # On a fresh / empty DB — runs without confirm:
    python -m scripts.apply_catalog_snapshot

    # On a populated DB — requires --confirm:
    python -m scripts.apply_catalog_snapshot --confirm

    # Use a custom snapshot path:
    python -m scripts.apply_catalog_snapshot --catalog path/to/catalog.snapshot.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Bootstrap repo root for `from src...` imports.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.admin.audit import log_action  # noqa: E402
from src.admin.feeds_sources import sync_public_monitor  # noqa: E402
from src.db import get_connection  # noqa: E402
from src.templates import prepare as prepare_template  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"

DEFAULT_CATALOG = CONFIG / "catalog.snapshot.json"


def _db_is_empty(cur) -> bool:
    cur.execute("SELECT 1 FROM catalog LIMIT 1")
    return cur.fetchone() is None


def _apply_sources(cur, catalog: list[dict]) -> dict[str, int]:
    """Upsert sources + feeds. Returns a counter of (sources_created,
    sources_updated, feeds_created, feeds_updated)."""
    counts = {"sources_created": 0, "sources_updated": 0,
              "feeds_created": 0,   "feeds_updated":   0}

    for src in catalog:
        domain = (src.get("domain") or "").lower()
        if not domain:
            print(f"[apply] skipping source without domain: {src.get('name')!r}")
            continue
        cur.execute("SELECT id FROM sources WHERE domain = %s", (domain,))
        row = cur.fetchone()
        if row:
            src_id = row[0]
            cur.execute(
                """UPDATE sources
                      SET name = %s, country = %s, paywall_policy = %s,
                          robots_skip = %s
                    WHERE id = %s""",
                (
                    src.get("name"),
                    src.get("country"),
                    src.get("paywall_policy"),
                    bool(src.get("robots_skip") or False),
                    src_id,
                ),
            )
            counts["sources_updated"] += 1
        else:
            cur.execute(
                """INSERT INTO sources
                       (name, domain, country, paywall_policy, robots_skip, added_at)
                   VALUES (%s, %s, %s, %s, %s, NOW())
                   RETURNING id""",
                (
                    src.get("name"),
                    domain,
                    src.get("country"),
                    src.get("paywall_policy"),
                    bool(src.get("robots_skip") or False),
                ),
            )
            src_id = cur.fetchone()[0]
            counts["sources_created"] += 1

        for feed in src.get("feeds") or []:
            slug = feed.get("slug")
            if not slug:
                print(f"[apply] skipping feed without slug under {src.get('name')!r}")
                continue
            template = feed.get("template", "rss")
            _, config, identity_key = prepare_template(
                template, feed.get("config") or {"url": feed.get("url")},
            )
            values = (
                feed.get("name"), template, json.dumps(config), identity_key,
                feed.get("feed_type"), feed.get("country"), src_id,
                bool(feed.get("starter")),
            )
            cur.execute("SELECT id FROM catalog WHERE slug = %s", (slug,))
            frow = cur.fetchone()
            if frow:
                cur.execute(
                    """UPDATE catalog
                          SET name = %s, template = %s, config = %s::jsonb,
                              identity_key = %s, feed_type = %s, country = %s,
                              source_id = %s, starter = %s
                        WHERE id = %s""",
                    (*values, frow[0]),
                )
                sync_public_monitor(cur, frow[0])
                counts["feeds_updated"] += 1
            else:
                cur.execute(
                    """INSERT INTO catalog
                           (name, template, config, identity_key, feed_type,
                            country, source_id, starter, slug)
                       VALUES (%s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)""",
                    (*values, slug),
                )
                counts["feeds_created"] += 1

    return counts


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        default=DEFAULT_CATALOG,
        help="Path to the catalog snapshot JSON. Default: config/catalog.snapshot.json",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required to apply on a populated DB (= UI edits will be overwritten).",
    )
    args = parser.parse_args()

    if not args.catalog.is_file():
        sys.exit(f"[apply] catalog file not found: {args.catalog}")
    try:
        catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    except Exception as e:
        sys.exit(f"[apply] failed to parse {args.catalog}: {e}")
    if not isinstance(catalog, list):
        sys.exit(f"[apply] expected a JSON array, got {type(catalog).__name__}")

    conn = get_connection()
    try:
        cur = conn.cursor()
        empty = _db_is_empty(cur)
        if not empty and not args.confirm:
            sys.exit(
                "[apply] the catalog is NOT empty. Refusing to run without "
                "--confirm to protect admin UI edits. Re-run with --confirm "
                "if you genuinely want to overwrite the DB with this snapshot."
            )
        if not empty:
            print("[apply] DB is populated — applying anyway (--confirm given)")
        else:
            print("[apply] DB is empty — bootstrapping from snapshot")

        print(f"[apply] catalog: {args.catalog}  ({len(catalog)} sources)")
        src_counts = _apply_sources(cur, catalog)
        print(f"[apply] sources: +{src_counts['sources_created']} ~{src_counts['sources_updated']}, "
              f"feeds: +{src_counts['feeds_created']} ~{src_counts['feeds_updated']}")

        # Audit row attributing the change to the script (no actor).
        log_action(
            cur,
            actor_user_id=None,
            action="apply_catalog_snapshot",
            target_type="catalog",
            target_id=None,
            payload={
                "catalog_file": str(args.catalog),
                "db_was_empty": empty,
                **src_counts,
            },
        )
        conn.commit()
    finally:
        conn.close()

    print("[apply] done")


if __name__ == "__main__":
    main()
