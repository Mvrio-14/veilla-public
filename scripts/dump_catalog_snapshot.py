"""
Dump the live catalog state (DB → JSON) for git-trackable snapshots.

Writes `config/catalog.snapshot.json`: the shape of `config/catalog.json`,
regenerated from sources + catalog, including paywall_policy / robots_skip
and each feed's `starter` flag. Git-diffable. Commit it to capture the
state of the catalog after admin UI changes.

The `.snapshot.json` suffix lets it coexist with the original
`catalog.json` without conflict. The original stays as the bootstrap
baseline; the snapshot is the "current truth" — committed regularly to
keep git in sync with prod.

# When to run

- After a session of admin UI edits (= regular cadence: weekly or daily)
- Before a major refactor (so you have a known-good baseline to rollback to)
- Manually via `python -m scripts.dump_catalog_snapshot`
- Optionally: wire into pg_cron later (`SELECT cron.schedule('catalog-
  snapshot', '0 4 * * *', $$ ... $$)` — but that's overkill for now)

# Round-trip with apply_catalog_snapshot.py

These two scripts are reverses of each other. A snapshot taken by this
script, fed into `apply_catalog_snapshot.py` on a fresh DB, restores
the exact same DB state. The shape of the JSON is intentionally identical
to the legacy `catalog.json` so any existing tooling that consumed it
keeps working.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Bootstrapping path for `from src.db import …` when run via
# `python -m scripts.dump_catalog_snapshot` from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.db import get_connection  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"

CATALOG_SNAPSHOT_PATH = CONFIG / "catalog.snapshot.json"


def _dump_catalog(conn) -> int:
    """Build `catalog.snapshot.json` from `sources` + `catalog`.

    Returns the number of sources written. Excludes feeds whose monitor
    is dead (they're invisible in the live API, no point
    keeping them in the snapshot — easier to re-add via the UI when
    they recover).
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, name, domain, country, paywall_policy, robots_skip
          FROM sources
         ORDER BY name ASC
        """
    )
    sources = cur.fetchall()

    out: list[dict] = []
    for src_id, name, domain, country, paywall_policy, robots_skip in sources:
        cur.execute(
            """
            SELECT c.slug, c.name, c.template, c.config, c.feed_type,
                   c.country, c.starter
              FROM catalog c
              LEFT JOIN monitors m ON m.catalog_id = c.id
             WHERE c.source_id = %s AND m.status IS DISTINCT FROM 'dead'
             ORDER BY c.name ASC
            """,
            (src_id,),
        )
        feeds = []
        for slug, fname, template, config, feed_type, lang, starter in cur.fetchall():
            entry: dict = {"slug": slug, "name": fname}
            if template == "rss":
                entry["url"] = config["url"]
            else:
                entry["template"] = template
                entry["config"]   = config
            if feed_type: entry["feed_type"] = feed_type
            if lang:      entry["country"]   = lang   # the historical
                                                       # column name; this
                                                       # is the feed's
                                                       # content language
                                                       # in practice.
            if starter:   entry["starter"]   = True
            feeds.append(entry)

        if not feeds:
            # Skip sources with zero live feeds — would clutter the
            # snapshot with phantom rows that the admin already
            # implicitly retired via the UI.
            continue

        src_entry: dict = {
            "name":   name,
            "domain": domain,
        }
        if country:        src_entry["country"]        = country
        src_entry["feeds"] = feeds
        if paywall_policy: src_entry["paywall_policy"] = paywall_policy
        if robots_skip:    src_entry["robots_skip"]    = bool(robots_skip)

        out.append(src_entry)

    CATALOG_SNAPSHOT_PATH.write_text(
        json.dumps(out, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return len(out)


def main() -> None:
    conn = get_connection()
    try:
        n_src = _dump_catalog(conn)
    finally:
        conn.close()
    print(f"[dump] catalog.snapshot.json ← {n_src} sources")
    print("[dump] done — git add / commit it for a versioned backup")


if __name__ == "__main__":
    main()
