-- ============================================================================
-- 0006 — Judgments: replay and budget skips
-- ============================================================================
-- A watcher's daily budget is for what arrives now. Two changes keep it so
-- (src/judge.py):
--
--   replay    the stories a new watcher judges from the week before it
--             existed. Capped on their own and not counted in the budget,
--             so a new watcher does not spend its first day on the past.
--   skipped   a verdict for a story the budget could not reach while it
--             was fresh. Recorded so the reader sees what was not judged,
--             and so the story is not judged hours late.
--
-- Apply BEFORE deploying the code that writes them.
-- ============================================================================

BEGIN;

ALTER TABLE judgments
    DROP CONSTRAINT judgments_verdict_check,
    ADD CONSTRAINT judgments_verdict_check
        CHECK (verdict IN ('kept', 'dropped', 'skipped')),
    ADD COLUMN replay boolean NOT NULL DEFAULT FALSE;

COMMIT;
