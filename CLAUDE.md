# Veilla — working notes for coding agents

Continuous news monitoring. RSS feeds are ingested, normalised by an LLM,
clustered into stories, summarised, and served to a Next.js app.

This file is context for agents. It holds what is **not guessable from
reading the code** — invariants, conventions, and the mistakes that have
already been made. Everything else belongs in the code or the README.

## Commands

```bash
# Backend (from the repo root, venv active)
pip install -r requirements_dev.txt   # runtime + pytest + ruff
pytest                                # no DB needed
ruff check .                          # config in pyproject.toml
uvicorn src.api:app --reload          # API
python -m src.runner                  # ingest worker (continuous loop)

# Frontend (from webapp/)
npm run dev · npm test · npm run lint · npm run typecheck · npm run build
```

CI runs exactly these. Both suites must pass before anything ships.

## Layout

```
src/            library: pipeline steps, loaders, notifications, auth
src/routes/     HTTP routes, one APIRouter per domain
src/admin/      admin business logic (the routes live in src/routes/admin.py)
mcp_server/     MCP tools exposed over stdio and over HTTP at /mcp
migrations/     versioned SQL, applied by hand (see below)
scripts/        CLI entry points — each one's docstring says what it is for
webapp/         Next.js 16 app
tests/          pytest; frontend tests sit next to their component
```

## Invariants

These are the things that bite.

**The database is the source of truth.** `config/catalog.json` seeds an
empty environment and nothing else. `sync_catalog_to_db` runs only when
`catalog` is empty; on a populated database it skips silently.
Force either way with `SKIP_CATALOG_SYNC=1` or `FORCE_CATALOG_SYNC=1`.
Feeds, sources and users are edited through `/admin`, never by editing
JSON.

**Subscriptions decide what is fetched.** There are no organisations.
A reader follows entries of the catalogue (`catalog`, never
fetched as such); following one subscribes them (`subscriptions`) to its
public monitor, created on first follow — see `src/monitors.py`. The
worker fetches a monitor if and only if an active user subscribes to it,
so readers of the same entry share one fetch. A new account follows the
entries flagged `starter`; there is no reader-facing picker yet. The
API still calls a catalogue entry a "feed", and its id is the one
`/admin/feeds` takes. Story
labels and syntheses are written once in English and translated once
per reader language, so every reader of a language sees the same
wording.

**Templates live in code, not in the schema.** A template is a package
under `src/templates/` implementing `base.Template`: `normalize` (the
config as stored), `identity_key` (what makes two monitors the same thing
to fetch, unique among public monitors) and `fetch(config, cursor)`,
which touches the network only and returns `FetchedItem`s in one shape
plus the cursor to resume from. Everything after — attribution,
deduplication, storage (`src/item_store.py`), health, moving a monitor
whose source has moved, the `monitor_runs` row — is done by
`src/collector.py` the same way for every template. Adding a template is
a package and a line in `TEMPLATES`; a template-specific `if` anywhere
else is the thing to avoid. Template (how it is fetched) and `kind` (what
the item is, `article` today) are independent.

**Every timestamp column is `TIMESTAMPTZ`.** Write
`datetime.now(timezone.utc)`. Never `datetime.utcnow()` — it is naive,
and `ruff`'s `DTZ` rules now fail the build on it.

**Write endpoints are closed by default.** `src/write_access.py` is a
middleware that refuses every mutating request unless the caller is on
the `pro` plan (`users.plan`). A new write route is therefore
unreachable for demo accounts until it is deliberately exempted. Read
that file before adding one: the exempt list is short on purpose, and
the line it draws (triage is allowed, authoring is not) is explained
there.

**Routes go in `src/routes/`, not in `src/api.py`.** `api.py` is the app:
lifespan, middlewares, the MCP mount, and `include_router` calls. Adding
a route means adding it to the matching router. The admin router carries
`dependencies=[Depends(require_admin)]`, so admin routes are protected
whether or not their author remembers the parameter.

**An item is only visible once it has a story.** The loader requires
both a normalisation and a `story_items` row. Normalisation happens at
step 2 of a worker pass and clustering at step 6, so an item is
deliberately held back for the few minutes in between. Relaxing that
filter reintroduces rows the UI cannot key: the detail panel, read
marking and the unread badge are all keyed by story id.

**Discovery is four layers, not two.**

| Layer | Table | Question it answers |
|---|---|---|
| Content | `items` | what was published |
| Publisher | `sources` | who published it |
| Discovery | `monitors` | how we found it |
| Hit | `monitor_items` | which monitor delivered what, when |

An item has no monitor column: the one that delivered it first is the
earliest `monitor_items` row, which is what the API's `feed_name` names.
A Google News monitor has `source_id NULL` — it is publisher-agnostic,
and attribution is resolved
per item from the RSS `<source>` tag, creating `sources` rows with
`auto_created = TRUE` on a miss. `UNIQUE(sources.domain)` makes that
concurrency-safe. Subdomains are distinct sources by design.

**Signal's agents are `watchers` in the code.** The interface says
"agents"; the tables (`watchers`, `watcher_monitors`, `judgments`), the
API (`/me/signal/watchers`) and `src/judge.py` say watcher, so that
"agent" stays free for other kinds. A watcher with no `watcher_monitors`
row reads every monitor its reader follows, including later ones.

**The MCP server acts as one configured identity.** `VEILLA_MCP_USER_SLUG`
is required — see `mcp_server/_identity.py`. Unset, the tools raise an
error naming the missing variable rather than guessing.

## Frontend conventions

**Next.js 16 has breaking changes.** Read `node_modules/next/dist/docs/`
before writing code, not your memory of Next 14. In particular the
middleware is `webapp/proxy.ts`, not `middleware.ts`.

**Do not call `setState` inside an effect.** The lint rule is on and the
codebase has no suppressions. Two helpers cover the common cases:
`lib/use-changed.ts` adjusts state during render when a prop changes,
and `lib/use-hydrated.ts` answers "is the browser available yet" without
the `mounted` flag. For data loading, split fetching from applying: the
fetch function touches no state, and the effect updates state from the
promise callback.

**Dialogs mount their body only while open.** A draft that is born with
the dialog and dies with it has nothing to reset, so a new field cannot
be forgotten.

## Migrations

`migrations/0001_baseline.sql` is the schema as of the baseline; the
migrations before it are in git history. Later migrations are written as
`migrations/NNNN_name.sql` against it and applied **by hand through the
Supabase SQL Editor**. `scripts/apply_migrations.py` exists for seeding an
empty environment; `scripts/run_migration.py` is for a migration that
exceeds the editor's 58 s timeout.

Browsers read nothing from the database directly except through
Realtime: every table has RLS on, and `authenticated` holds SELECT only
on `folders`, `views` and `folder_stories`, filtered by the policies at
the end of the baseline. A new table stays closed unless a migration
grants it deliberately.

Postgres extensions in use: `pgvector` (HNSW indexes on story centroids),
`pg_cron` (the daily purge), `unaccent` (accent-insensitive search).

## Data retention

A `pg_cron` job, `cleanup-old-data`, runs at 03:00 UTC. It deletes an
item older than 14 days unless it belongs to an active story, a saved
story, or a story filed in a folder — and a closed story once it has no
items, no saves and no folder. Every foreign key cascades, so deleting
an item or a story cleans up its junction rows.

`scripts/cleanup_old_data.py` runs the same logic from a shell, for
debugging. It is not what runs in production.

A second job, `purge-monitor-runs` (03:15 UTC), keeps fourteen days of
`monitor_runs`: one row per fetch of a monitor, 304s included.

## Known gaps

- Two eslint warnings remain, from the React Compiler about TanStack
  Virtual (the Watch list and the Monitors list). They are upstream and
  not actionable.
