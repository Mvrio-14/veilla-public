-- ============================================================================
-- 0007 — Judgments: no replay
-- ============================================================================
-- A watcher now watches from the moment it is created and never judges
-- what came before (src/judge.py), so nothing is a replay any more and
-- the flag that kept replays out of the daily budget goes.
--
-- Apply AFTER deploying the code that no longer reads the column: the
-- previous API and worker read it on every request and pass.
-- ============================================================================

BEGIN;

ALTER TABLE judgments DROP COLUMN replay;

COMMIT;
