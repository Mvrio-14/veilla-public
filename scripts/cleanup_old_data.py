"""
Periodic cleanup of stale items and dangling closed stories.

In production, the **same cleanup runs via pg_cron in Supabase** (job
`cleanup-old-data`, schedule `0 3 * * *`, defined in
migrations/0001_baseline.sql). This script runs the same statements from
a shell, for a one-off debug when the job failed or a local run.

Retention rules (must match the SQL of the pg_cron job exactly):
  - **Item** is deletable when it was fetched more than 14 days ago and
    none of its stories is active, saved by anyone, or filed in a folder.

  - **Story** is deletable when it is closed, nobody saved it, it is in
    no folder, and it has no items left (after the step above).

Every foreign key cascades, so deleting an item or a story cleans up its
junction rows (story_items, monitor_items, item_entities, user_item_reads,
story_updates, and the per-user story tables).

Idempotent — safe to re-run on any schedule. Nothing to do = no rows deleted.

CLI:
    python -m scripts.cleanup_old_data
"""
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

sys.stdout.reconfigure(line_buffering=True)

from src.db import get_connection  # noqa: E402

# 14 days is comfortable: the /watch window is at most a few days, so an
# older item is only reachable through a saved or filed story, which is
# protected. The buffer covers a reader coming back later in the week.
ITEM_RETENTION_DAYS = 14


def cleanup() -> dict:
    conn = get_connection()
    cur = conn.cursor()
    try:
        cur.execute(
            """
            DELETE FROM items i
             WHERE i.fetched_at < now() - (%s::int * interval '1 day')
               AND NOT EXISTS (
                   SELECT 1
                     FROM story_items si
                     JOIN stories s ON s.id = si.story_id
                    WHERE si.item_id = i.id
                      AND (
                            s.status = 'active'
                         OR EXISTS (SELECT 1 FROM user_story_saves us WHERE us.story_id = s.id)
                         OR EXISTS (SELECT 1 FROM folder_stories fs WHERE fs.story_id = s.id)
                      )
               )
            """,
            (ITEM_RETENTION_DAYS,),
        )
        n_items = cur.rowcount
        conn.commit()
        print(f"[cleanup] items deleted: {n_items}", flush=True)

        cur.execute(
            """
            DELETE FROM stories s
             WHERE s.status = 'closed'
               AND NOT EXISTS (SELECT 1 FROM story_items si      WHERE si.story_id = s.id)
               AND NOT EXISTS (SELECT 1 FROM user_story_saves us WHERE us.story_id = s.id)
               AND NOT EXISTS (SELECT 1 FROM folder_stories fs   WHERE fs.story_id = s.id)
            """
        )
        n_stories = cur.rowcount
        conn.commit()
        print(f"[cleanup] orphan closed stories deleted: {n_stories}", flush=True)

        return {"items_deleted": n_items, "stories_deleted": n_stories}
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    result = cleanup()
    print(f"[cleanup] done — {result}", flush=True)
