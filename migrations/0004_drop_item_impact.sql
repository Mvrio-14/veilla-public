-- ============================================================================
-- 0004 — Drop items.impact
-- ============================================================================
-- Nothing writes `impact`; the loader read it only into a story score
-- that nothing used. Both are gone from the code.
--
-- Apply AFTER the code that no longer reads the column is deployed: the
-- previous API selects it on every /watch request.
-- ============================================================================

BEGIN;

ALTER TABLE items DROP COLUMN impact;

COMMIT;
