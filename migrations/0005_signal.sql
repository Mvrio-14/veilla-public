-- ============================================================================
-- 0005 — Signal: context, watchers, judgments
-- ============================================================================
-- A watcher reads the stories of a reader's monitors and decides, against
-- a request the reader wrote, which ones to keep (src/judge.py). Every
-- watcher of a reader also reads the reader's context: one paragraph on
-- who they are and what counts as news for them.
--
--   users.context     the paragraph, shared by all of a reader's watchers
--   watchers          a standing request, active or paused
--   watcher_monitors  the monitors a watcher reads; none means all of the
--                     reader's monitors, including ones followed later
--   judgments         one verdict of one watcher on one story, with the
--                     reason, what the watcher was given, and its cost
--
-- A judgment covers the articles of the story that were new to the
-- watcher (`item_ids`); an article in a later judgment is one that arrived
-- since. Judgments made on the same worker pass share `pass_at`, which is
-- how the Decisions screen groups the verdicts of several watchers on one
-- story.
--
-- Nothing is granted to `authenticated`: the API reads and writes these.
-- ============================================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN context     text NOT NULL DEFAULT '',
    ADD COLUMN context_at  timestamptz;

CREATE TABLE watchers (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        text NOT NULL CHECK (btrim(name) <> ''),
    request     text NOT NULL CHECK (btrim(request) <> ''),
    status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_watchers_user ON watchers (user_id);

CREATE TRIGGER watchers_touch_updated_at
    BEFORE UPDATE ON watchers
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE watcher_monitors (
    watcher_id  bigint NOT NULL REFERENCES watchers (id) ON DELETE CASCADE,
    monitor_id  bigint NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    PRIMARY KEY (watcher_id, monitor_id)
);

CREATE TABLE judgments (
    id             bigserial PRIMARY KEY,
    watcher_id     bigint NOT NULL REFERENCES watchers (id) ON DELETE CASCADE,
    story_id       bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    pass_at        timestamptz NOT NULL,
    item_ids       bigint[] NOT NULL,
    verdict        text NOT NULL CHECK (verdict IN ('kept', 'dropped')),
    reason         text NOT NULL,
    excerpt        text,
    -- The label, synthesis, articles and earlier reason sent to the model.
    input          jsonb NOT NULL,
    model          text NOT NULL,
    input_tokens   integer NOT NULL DEFAULT 0,
    output_tokens  integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_judgments_watcher_story   ON judgments (watcher_id, story_id);
CREATE INDEX idx_judgments_watcher_created ON judgments (watcher_id, created_at DESC);

ALTER TABLE watchers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE watcher_monitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE judgments        ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON watchers, watcher_monitors, judgments FROM anon, authenticated;

COMMIT;
