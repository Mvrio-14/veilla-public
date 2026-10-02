-- ============================================================================
-- 0001 — Baseline
-- ============================================================================
-- The whole schema in one file. It replaces migrations 0001 to 0070, which
-- git history keeps; later migrations are written against this one.
--
-- ## How content reaches a reader
--
--   catalog         what we offer to follow: a template and its settings,
--                   curated in /admin. Never fetched as such.
--   monitors        what the worker fetches. Subscribing to a catalog entry
--                   gets or creates its public monitor, so a feed a hundred
--                   people follow is fetched once.
--   subscriptions   who follows which monitor. A monitor is fetched if and
--                   only if an active user subscribes to it.
--   items           what the monitors brought back, deduplicated across
--                   them. `kind` says what an item is (an article today);
--                   the template says how it was fetched. The two are
--                   independent.
--   monitor_items   which monitor delivered which item, and when.
--   stories         items about the same event, clustered on embeddings.
--
-- ## Templates
--
-- A template is how a monitor fetches: `rss` or `google_news` today. The
-- list lives in code (src/templates.py), not in a CHECK, so that adding
-- one needs no migration. `fetch_method` is the coarse transport a
-- template uses; that list is short and stable, so it is a CHECK.
--
-- ## Access from Supabase clients
--
-- The API and the worker connect as the owner of these tables, which
-- bypasses row-level security. Browsers read nothing directly except
-- through Supabase Realtime, which needs `authenticated` to be able to
-- SELECT the three tables it streams, filtered by the policies at the end
-- of this file. Every other table has RLS on, no policy and no grant.
--
-- Written for Supabase: it expects the `auth` schema, the `anon` and
-- `authenticated` roles and the `supabase_realtime` publication.
-- ============================================================================

BEGIN;

-- ── Extensions ──────────────────────────────────────────────────────────────

-- In `public`, where production has always had them: the schema below
-- names their types and functions unqualified.
CREATE EXTENSION IF NOT EXISTS vector   WITH SCHEMA public;  -- story centroids, item embeddings
CREATE EXTENSION IF NOT EXISTS pg_trgm  WITH SCHEMA public;  -- fuzzy entity lookup
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;  -- accent-insensitive search
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_cron;                       -- the nightly purge

-- Nothing created below is readable by the public API roles unless granted
-- here explicitly. Without this, Supabase's defaults hand every new table
-- to `anon` and `authenticated`.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;


-- ── Helpers ─────────────────────────────────────────────────────────────────

-- `unaccent` is STABLE because its dictionary could change; a generated
-- column needs an IMMUTABLE function. Naming the dictionary makes the
-- result fixed, which is what this wrapper promises. Everything is
-- schema-qualified so that the body resolves under any search_path —
-- pg_restore runs with an empty one.
CREATE FUNCTION immutable_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;


-- ── People ──────────────────────────────────────────────────────────────────

CREATE TABLE users (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                  text NOT NULL UNIQUE,
    name                  text,
    email                 text,
    -- Linked on first sign-in; NULL for an account that never signed in.
    auth_id               uuid UNIQUE REFERENCES auth.users (id),
    output_lang           text NOT NULL DEFAULT 'fr',
    understood_languages  text[] NOT NULL DEFAULT '{}',
    active                boolean NOT NULL DEFAULT TRUE,
    is_public             boolean NOT NULL DEFAULT FALSE,
    plan                  text NOT NULL DEFAULT 'demo'
                          CHECK (plan IN ('demo', 'pro')),
    profile               jsonb,
    preferences           jsonb NOT NULL DEFAULT '{}',
    notif_prefs           jsonb NOT NULL DEFAULT '{}',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN users.plan IS
    'demo = read-only, pro = can save, file and create. Checked by '
    'src/write_access.py on every mutating request.';

CREATE INDEX idx_users_active ON users (id) WHERE active;

CREATE TRIGGER users_touch_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ── Publishers and the catalog ──────────────────────────────────────────────

CREATE TABLE sources (
    id              bigserial PRIMARY KEY,
    name            text NOT NULL,
    -- Canonical domain, without `www.`. Subdomains are distinct sources.
    domain          text NOT NULL UNIQUE,
    country         text,
    paywall_policy  text CHECK (paywall_policy IN ('paywall', 'mixed', 'free')),
    robots_skip     boolean NOT NULL DEFAULT FALSE,
    -- Created by the collector for a publisher first seen through a
    -- Google News result, rather than curated.
    auto_created    boolean NOT NULL DEFAULT FALSE,
    added_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog (
    id            bigserial PRIMARY KEY,
    slug          text NOT NULL UNIQUE,
    name          text NOT NULL,
    template      text NOT NULL,
    config        jsonb NOT NULL,
    -- What makes two entries the same thing to fetch, computed by the
    -- template from its config: the URL for RSS, the query for Google News.
    identity_key  text NOT NULL UNIQUE,
    -- NULL for a Google News query, whose publisher is resolved per item.
    source_id     bigint REFERENCES sources (id) ON DELETE SET NULL,
    feed_type     text,
    -- Language of the content (ISO 639-1), despite the name.
    country       text,
    starter       boolean NOT NULL DEFAULT FALSE,
    added_at      timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN catalog.starter IS
    'Subscribed to automatically when an account signs up.';

CREATE INDEX idx_catalog_source ON catalog (source_id);

CREATE TRIGGER catalog_touch_updated_at
    BEFORE UPDATE ON catalog
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ── Monitors ────────────────────────────────────────────────────────────────

CREATE TABLE monitors (
    id                    bigserial PRIMARY KEY,
    name                  text NOT NULL,
    template              text NOT NULL,
    fetch_method          text NOT NULL
                          CHECK (fetch_method IN ('rss', 'api', 'scrape', 'email')),
    -- What the items it brings back are.
    kind                  text NOT NULL DEFAULT 'article',
    config                jsonb NOT NULL,
    identity_key          text NOT NULL,
    -- A public monitor is shared by everyone who follows the same thing;
    -- a private one belongs to its creator.
    visibility            text NOT NULL DEFAULT 'private'
                          CHECK (visibility IN ('public', 'private')),
    created_by            uuid REFERENCES users (id) ON DELETE SET NULL,
    -- The catalogue entry a public monitor fetches. Removing the entry
    -- removes its monitor, and with it who followed it.
    catalog_id            bigint UNIQUE REFERENCES catalog (id) ON DELETE CASCADE,
    source_id             bigint REFERENCES sources (id) ON DELETE SET NULL,
    -- Health, written by the worker. `dead` is also how an admin retires
    -- a monitor; only an admin brings one back.
    status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'degraded', 'dead')),
    consecutive_failures  integer NOT NULL DEFAULT 0,
    last_success_at       timestamptz,
    last_failure_at       timestamptz,
    -- Where the last fetch left off, in the template's own terms. For RSS:
    -- etag, last_modified, and the redirect target seen on recent passes.
    cursor                jsonb NOT NULL DEFAULT '{}',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CHECK (visibility = 'public' OR created_by IS NOT NULL)
);

CREATE UNIQUE INDEX uq_monitors_public_identity
    ON monitors (identity_key) WHERE visibility = 'public';
CREATE INDEX idx_monitors_source ON monitors (source_id);

CREATE TRIGGER monitors_touch_updated_at
    BEFORE UPDATE ON monitors
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE subscriptions (
    user_id     uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    monitor_id  bigint NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, monitor_id)
);

CREATE INDEX idx_subscriptions_monitor ON subscriptions (monitor_id);


-- ── Items ───────────────────────────────────────────────────────────────────

CREATE TABLE items (
    id                     bigserial PRIMARY KEY,
    kind                   text NOT NULL DEFAULT 'article',
    source_id              bigint REFERENCES sources (id) ON DELETE SET NULL,
    guid                   text,
    url                    text NOT NULL UNIQUE,
    -- The deduplication key: publisher host, minute, language and title
    -- when all are known, the cleaned URL otherwise.
    canonical_url          text,
    title                  text NOT NULL,
    summary                text,
    content                text,
    content_type           text,
    author                 text,
    authors                jsonb,
    tags                   jsonb,
    image_url              text,
    raw_entry              jsonb NOT NULL,
    published_at           timestamptz,
    updated_at             timestamptz,
    fetched_at             timestamptz NOT NULL,
    -- Seen on a monitor's first pass without a publication date: kept for
    -- deduplication, never shown, since it may be old backlog.
    archive_seed           boolean NOT NULL DEFAULT FALSE,

    -- Written by the pipeline, in the order it runs.
    lang                   text,
    title_normalized       text,
    summary_normalized     text,
    title_translations     jsonb,
    summary_translations   jsonb NOT NULL DEFAULT '{}',
    category               jsonb,
    countries              jsonb,
    impact                 real,
    keywords               jsonb,
    entities               jsonb,
    article_type           text,
    entities_resolved_at   timestamptz,
    title_embedding        vector(1536),
    summary_embedding      vector(1536),
    summary_full           text,
    paywall_status         text CHECK (paywall_status IN ('paywall', 'free', 'unknown')),
    paywall_signal         text,
    content_length_words   integer,
    content_length_source  text,
    enriched_at            timestamptz,

    search_vector          tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(title, '') || ' ' || coalesce(title_normalized, '')
        )), 'A')
        || setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(summary, '') || ' ' || coalesce(summary_normalized, '')
            || ' ' || coalesce(summary_full, '')
        )), 'B')
        || setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(keywords::text, '')
        )), 'C')
        || setweight(to_tsvector('simple', immutable_unaccent(
            coalesce(entities::text, '')
        )), 'D')
    ) STORED
);

CREATE INDEX idx_items_canonical_url       ON items (canonical_url);
CREATE INDEX idx_items_fetched_at          ON items (fetched_at);
CREATE INDEX idx_items_published_at        ON items (published_at);
CREATE INDEX idx_items_pub_visible         ON items (published_at DESC)
    WHERE NOT archive_seed AND published_at IS NOT NULL;
CREATE INDEX idx_items_source              ON items (source_id);
CREATE INDEX idx_items_lang                ON items (lang);
CREATE INDEX idx_items_normalized          ON items (title_normalized)
    WHERE title_normalized IS NOT NULL AND title_normalized <> '';
CREATE INDEX idx_items_pending_enrichment  ON items (id) WHERE enriched_at IS NULL;
CREATE INDEX idx_items_pending_entities    ON items (id)
    WHERE entities IS NOT NULL AND entities_resolved_at IS NULL;
CREATE INDEX idx_items_search_vector       ON items USING gin (search_vector);
CREATE INDEX idx_items_category            ON items USING gin (category);
CREATE INDEX idx_items_countries           ON items USING gin (countries);
CREATE INDEX idx_items_keywords            ON items USING gin (keywords);
CREATE INDEX idx_items_entities            ON items USING gin (entities);
CREATE INDEX idx_items_title_translations  ON items USING gin (title_translations);
CREATE INDEX idx_items_summary_translations ON items USING gin (summary_translations);

-- A translation exists only for languages other than the item's own; this
-- tells the planner so, which it cannot infer from the two columns alone.
CREATE STATISTICS items_lang_title_translations (dependencies)
    ON lang, title_translations FROM items;
CREATE STATISTICS items_lang_summary_translations (dependencies)
    ON lang, summary_translations FROM items;

CREATE TABLE monitor_items (
    item_id     bigint NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    monitor_id  bigint NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
    fetched_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, monitor_id)
);

CREATE INDEX idx_monitor_items_monitor ON monitor_items (monitor_id);


-- ── Entities ────────────────────────────────────────────────────────────────

CREATE TABLE entities (
    id                  bigserial PRIMARY KEY,
    wikidata_id         text UNIQUE,
    kind                text NOT NULL
                        CHECK (kind IN ('person', 'org', 'location', 'event', 'market', 'product')),
    canonical_label     text NOT NULL,
    description         text,
    country             text,
    instance_of         text[],
    industry            text,
    aliases             text[] NOT NULL DEFAULT '{}',
    label_translations  jsonb NOT NULL DEFAULT '{}',
    image_url           text,
    -- Entities found to be the same thing point at one of them.
    cluster_id          bigint REFERENCES entities (id) ON DELETE SET NULL,
    status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'merged', 'deleted')),
    source              text NOT NULL DEFAULT 'wikidata'
                        CHECK (source IN ('wikidata', 'manual', 'unlinked')),
    last_refreshed_at   timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_entities_kind            ON entities (kind);
CREATE INDEX idx_entities_country         ON entities (country) WHERE country IS NOT NULL;
CREATE INDEX idx_entities_cluster         ON entities (cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX idx_entities_aliases         ON entities USING gin (aliases);
CREATE INDEX idx_entities_canonical_trgm  ON entities USING gin (canonical_label gin_trgm_ops);

CREATE TRIGGER entities_touch_updated_at
    BEFORE UPDATE ON entities
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE item_entities (
    item_id        bigint NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    entity_id      bigint NOT NULL REFERENCES entities (id) ON DELETE CASCADE,
    salience       smallint NOT NULL DEFAULT 3 CHECK (salience BETWEEN 1 AND 5),
    surface_form   text NOT NULL,
    kind_at_match  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (item_id, entity_id)
);

CREATE INDEX idx_item_entities_entity ON item_entities (entity_id);


-- ── Stories ─────────────────────────────────────────────────────────────────

CREATE TABLE stories (
    id                         bigserial PRIMARY KEY,
    status                     text NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'closed')),
    n_items                    integer NOT NULL DEFAULT 1,
    latest_pub                 timestamptz NOT NULL,
    last_attached_at           timestamptz NOT NULL DEFAULT now(),
    centroid                   vector(1536),
    created_at                 timestamptz NOT NULL DEFAULT now(),

    -- Written once in English, translated once per reader language.
    label                      text,
    label_lang                 text,
    label_translations         jsonb NOT NULL DEFAULT '{}',
    last_labeled_at            timestamptz,
    n_items_at_last_label      integer,

    synthesis_normalized       text,
    synthesis_translations     jsonb NOT NULL DEFAULT '{}',
    synthesis_at               timestamptz,
    n_items_at_last_synthesis  integer,

    origin_normalized          text,
    origin_translations        jsonb NOT NULL DEFAULT '{}',
    origin_at                  timestamptz
);

CREATE INDEX idx_stories_status_latest_pub ON stories (status, latest_pub DESC);
CREATE INDEX idx_stories_label_refresh     ON stories (last_attached_at) WHERE status = 'active';
CREATE INDEX idx_stories_synthesis_stale   ON stories (last_attached_at)
    WHERE synthesis_at IS NULL OR last_attached_at > synthesis_at;
CREATE INDEX idx_stories_origin_pending    ON stories (id) WHERE origin_normalized IS NULL;
CREATE INDEX idx_stories_centroid          ON stories USING hnsw (centroid vector_cosine_ops);

CREATE TABLE story_items (
    story_id                 bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    item_id                  bigint NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    attached_at              timestamptz NOT NULL DEFAULT now(),
    -- Set once the item has been read for what it adds to its story.
    analyzed_for_updates_at  timestamptz,
    PRIMARY KEY (story_id, item_id)
);

CREATE INDEX idx_story_items_item       ON story_items (item_id);
CREATE INDEX idx_story_items_unanalyzed ON story_items (story_id, attached_at)
    WHERE analyzed_for_updates_at IS NULL;

-- What an item added to its story, in one sentence.
CREATE TABLE story_updates (
    id              bigserial PRIMARY KEY,
    story_id        bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    source_item_id  bigint NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    content         text NOT NULL,
    translations    jsonb NOT NULL DEFAULT '{}',
    added_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_story_updates_story_added_at ON story_updates (story_id, added_at DESC);
CREATE INDEX idx_story_updates_source_item    ON story_updates (source_item_id);


-- ── What each reader did ────────────────────────────────────────────────────

CREATE TABLE user_story_saves (
    user_id   uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    story_id  bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    saved_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, story_id)
);

CREATE INDEX idx_user_story_saves_user_saved_at ON user_story_saves (user_id, saved_at DESC);
CREATE INDEX idx_user_story_saves_story         ON user_story_saves (story_id);

CREATE TABLE user_story_ignores (
    user_id     uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    story_id    bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    ignored_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, story_id)
);

CREATE TABLE user_story_reads (
    user_id   uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    story_id  bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    read_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, story_id)
);

CREATE TABLE user_item_reads (
    user_id  uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    item_id  bigint NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    read_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, item_id)
);

CREATE TABLE story_follows (
    user_id      uuid   NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    story_id     bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    followed_at  timestamptz NOT NULL DEFAULT now(),
    -- NULL follows the story for as long as it lives.
    expires_at   timestamptz,
    PRIMARY KEY (user_id, story_id)
);

CREATE INDEX idx_story_follows_story      ON story_follows (story_id);
CREATE INDEX idx_story_follows_expires_at ON story_follows (expires_at)
    WHERE expires_at IS NOT NULL;

-- A saved search.
CREATE TABLE views (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name           text NOT NULL,
    criteria       jsonb NOT NULL,
    criteria_text  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

COMMENT ON COLUMN views.criteria_text IS
    'Boolean query in Lucene syntax, parsed by src/boolean_query.py. '
    '`criteria` is read only where this is NULL.';

CREATE TRIGGER views_touch_updated_at
    BEFORE UPDATE ON views
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE folders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

CREATE TRIGGER folders_touch_updated_at
    BEFORE UPDATE ON folders
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE folder_stories (
    folder_id  uuid   NOT NULL REFERENCES folders (id) ON DELETE CASCADE,
    story_id   bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (folder_id, story_id)
);

CREATE INDEX idx_folder_stories_story ON folder_stories (story_id);

CREATE TABLE notifications (
    id          bigserial PRIMARY KEY,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type        text NOT NULL CHECK (type IN ('story_update')),
    payload     jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    read_at     timestamptz
);

CREATE INDEX idx_notifications_user_recent ON notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;


-- ── Operations ──────────────────────────────────────────────────────────────

-- One row per mutation made through /admin.
CREATE TABLE admin_actions (
    id             bigserial PRIMARY KEY,
    actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    action         text NOT NULL,
    target_type    text NOT NULL,
    target_id      text,
    payload        jsonb NOT NULL DEFAULT '{}',
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_actions_created_at ON admin_actions (created_at DESC);
CREATE INDEX idx_admin_actions_target     ON admin_actions (target_type, target_id);

-- One row per LLM call: what it cost, for which step, on whose behalf.
CREATE TABLE llm_calls (
    id             bigserial PRIMARY KEY,
    ts             timestamptz NOT NULL DEFAULT now(),
    model          text NOT NULL,
    -- The pipeline step, named as in src/runner.py.
    step           text NOT NULL,
    -- Which kind of call, when a step makes more than one.
    purpose        text,
    user_id        uuid   REFERENCES users (id) ON DELETE SET NULL,
    view_id        uuid   REFERENCES views (id) ON DELETE SET NULL,
    story_id       bigint REFERENCES stories (id) ON DELETE SET NULL,
    item_id        bigint REFERENCES items (id) ON DELETE SET NULL,
    input_tokens   integer NOT NULL DEFAULT 0,
    output_tokens  integer NOT NULL DEFAULT 0,
    cost_usd       numeric(10, 6) NOT NULL DEFAULT 0,
    duration_ms    integer,
    success        boolean NOT NULL DEFAULT TRUE,
    error          text
);

CREATE INDEX idx_llm_calls_ts       ON llm_calls (ts DESC);
CREATE INDEX idx_llm_calls_step_ts  ON llm_calls (step, ts DESC);
CREATE INDEX idx_llm_calls_model_ts ON llm_calls (model, ts DESC);
CREATE INDEX idx_llm_calls_user_ts  ON llm_calls (user_id, ts DESC) WHERE user_id IS NOT NULL;


-- ── Retention ───────────────────────────────────────────────────────────────
-- An item older than 14 days goes, unless its story is still active, saved,
-- or filed in a folder. A closed story goes once it has no items, no saves
-- and no folder. Foreign keys cascade to the junction rows.
-- scripts/cleanup_old_data.py runs the same statements from a shell.

SELECT cron.schedule(
    'cleanup-old-data',
    '0 3 * * *',
    $job$
    DELETE FROM items i
     WHERE i.fetched_at < now() - interval '14 days'
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
       );

    DELETE FROM stories s
     WHERE s.status = 'closed'
       AND NOT EXISTS (SELECT 1 FROM story_items si      WHERE si.story_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM user_story_saves us WHERE us.story_id = s.id)
       AND NOT EXISTS (SELECT 1 FROM folder_stories fs   WHERE fs.story_id = s.id);
    $job$
);


-- ── Realtime ────────────────────────────────────────────────────────────────
-- The browser subscribes to changes on a user's folders, views and folder
-- contents. Realtime delivers a change only to a client allowed to SELECT
-- the row, so `authenticated` gets SELECT on these three tables and the
-- policies below narrow it to the user's own rows.

-- Supabase Auth's user id, as our users.id.
CREATE FUNCTION current_user_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = ''
    AS $$
  SELECT id FROM public.users WHERE auth_id = (SELECT auth.uid())
$$;

CREATE FUNCTION can_see_folder(target_folder_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = ''
    AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.folders f
     WHERE f.id = target_folder_id
       AND f.user_id = (SELECT public.current_user_id())
  )
$$;

-- An UPDATE or DELETE event carries the old row only with a full replica
-- identity; the policies need its user_id and folder_id.
ALTER TABLE folders        REPLICA IDENTITY FULL;
ALTER TABLE views          REPLICA IDENTITY FULL;
ALTER TABLE folder_stories REPLICA IDENTITY FULL;

CREATE POLICY folders_realtime_select ON folders
    FOR SELECT TO authenticated
    USING (user_id = (SELECT current_user_id()));

CREATE POLICY views_realtime_select ON views
    FOR SELECT TO authenticated
    USING (user_id = (SELECT current_user_id()));

CREATE POLICY folder_stories_realtime_select ON folder_stories
    FOR SELECT TO authenticated
    USING ((SELECT can_see_folder(folder_id)));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE folders, views, folder_stories;
    END IF;
END;
$$;


-- ── Privileges ──────────────────────────────────────────────────────────────
-- Row-level security everywhere: a table without a policy is closed to the
-- API roles even if a grant slips through later.

DO $$
DECLARE
    t text;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON FUNCTION current_user_id(), can_see_folder(uuid) FROM PUBLIC, anon;

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON folders, views, folder_stories TO authenticated;
GRANT EXECUTE ON FUNCTION current_user_id(), can_see_folder(uuid) TO authenticated;

COMMIT;
