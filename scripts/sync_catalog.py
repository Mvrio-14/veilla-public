"""
CLI wrapper around src.catalog_sync.sync_catalog_to_db.

The actual sync logic lives in `src/catalog_sync.py` and is also called at
FastAPI app startup (src/api.py lifespan) to seed an empty database.

This script runs it by hand — on a populated database too, which is what
FORCE_CATALOG_SYNC does at startup — and prints detailed per-source /
per-feed change lists.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.catalog_sync import sync_catalog_to_db
from src.db import get_connection


def _print_detailed(stats: dict) -> None:
    """Verbose per-item output for the CLI use case."""
    src   = stats["sources"]
    feeds = stats["feeds"]

    if src["added"]:
        print(f"\n[SOURCES +]  {len(src['added'])} added:")
        for name in src["added"]:
            print(f"  + {name}")
    if src["updated"]:
        print(f"\n[SOURCES ~]  {len(src['updated'])} updated:")
        for desc in src["updated"]:
            print(f"  ~ {desc}")

    if feeds["added"]:
        print(f"\n[FEEDS +]    {len(feeds['added'])} added:")
        for name in feeds["added"]:
            print(f"  + {name}")
    if feeds["updated"]:
        print(f"\n[FEEDS ~]    {len(feeds['updated'])} updated:")
        for desc in feeds["updated"]:
            print(f"  ~ {desc}")
    if feeds["removed"]:
        if feeds["remove_executed"]:
            print(f"\n[FEEDS -]    {len(feeds['removed'])} deleted from DB:")
        else:
            print(f"\n[WARN]       {len(feeds['removed'])} catalog feed(s) absent from catalog.json:")
            print("             Run with --remove to delete them.")
        for name in feeds["removed"]:
            print(f"  - {name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--remove", action="store_true",
        help="Delete catalog entries absent from catalog.json",
    )
    args = parser.parse_args()

    stats = sync_catalog_to_db(remove=args.remove, verbose=True)
    _print_detailed(stats)

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM sources"); n_sources = cur.fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM catalog"); n_feeds = cur.fetchone()[0]
    finally:
        conn.close()
    print(f"\nDB: {n_sources} sources  |  {n_feeds} catalog feeds")
