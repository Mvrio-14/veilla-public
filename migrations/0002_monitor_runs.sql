-- ============================================================================
-- 0002 — Monitor runs
-- ============================================================================
-- One row per fetch of a monitor: when, how long, what came of it. It is
-- what answers "why has this feed brought nothing since yesterday?" —
-- the monitor's health columns only say how many fetches in a row failed,
-- not what each one did.
--
-- A 304 is recorded too: a feed that has answered "not modified" for three
-- days is worth knowing about.
--
-- About one row per monitor per worker pass, so a few tens of thousands a
-- day; a nightly job keeps fourteen days.
-- ============================================================================

BEGIN;

CREATE TABLE monitor_runs (
    id           bigserial PRIMARY KEY,
    monitor_id   bigint NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    started_at   timestamptz NOT NULL,
    duration_ms  integer NOT NULL,
    outcome      text NOT NULL CHECK (outcome IN ('ok', 'not_modified', 'failed')),
    -- What the template returned, and how many of those were new items.
    items_seen   integer NOT NULL DEFAULT 0,
    items_new    integer NOT NULL DEFAULT 0,
    error        text
);

CREATE INDEX idx_monitor_runs_monitor_started ON monitor_runs (monitor_id, started_at DESC);
CREATE INDEX idx_monitor_runs_started         ON monitor_runs (started_at);

ALTER TABLE monitor_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON monitor_runs FROM anon, authenticated;

SELECT cron.schedule(
    'purge-monitor-runs',
    '15 3 * * *',
    $job$ DELETE FROM monitor_runs WHERE started_at < now() - interval '14 days' $job$
);

COMMIT;
