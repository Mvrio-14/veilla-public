-- ============================================================================
-- 0003 — Story text kept by story_state
-- ============================================================================
-- The label, synthesis and timeline are now written by one call per story
-- when it has unread articles (src/story_state.py), instead of the labeler
-- and synthesis generator re-running on a cooldown-and-growth rule. What
-- that rule needed goes: the story size at the last label and synthesis,
-- and the indexes that found the stories it selected.
--
-- Apply AFTER the code that no longer writes these columns is deployed:
-- the previous worker writes them on every pass.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_stories_label_refresh;
DROP INDEX IF EXISTS idx_stories_synthesis_stale;
DROP INDEX IF EXISTS idx_stories_origin_pending;

ALTER TABLE stories
    DROP COLUMN n_items_at_last_label,
    DROP COLUMN n_items_at_last_synthesis;

COMMIT;
