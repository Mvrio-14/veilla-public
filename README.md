# Veilla

[![CI](https://github.com/Mvrio-14/veilla-public/actions/workflows/ci.yml/badge.svg)](https://github.com/Mvrio-14/veilla-public/actions/workflows/ci.yml)

News monitoring for journalists. Veilla watches the sources a reader
follows, in any language, groups what it finds into **stories** rather
than a list of articles, and lets them hand the first read to agents
that say, for every story, whether it matters to them and why.

The problem it solves is a morning spent in twenty browser tabs reading
the same event five times. Veilla reads them instead: it clusters the
coverage, keeps a short factual synthesis and a timeline per story, and
leaves the reader with the stories worth their time.

## What it does

**Desk — clusters, rather than lists.** Ten outlets covering one event
become one story with one synthesis, not ten rows. Clustering is
incremental: every new article is matched against open stories by vector
similarity, so there is no global re-clustering pass to wait for. Each
story keeps a timeline — one note per article that added something — so
it reads as a sequence of facts rather than a summary to reread.

**Reads every language, answers in yours.** Titles are normalised into
canonical English for clustering; labels and syntheses are written once
in English and translated once per reader language, so every reader of a
language sees the same wording. The original is always one click away.

**Lets people say precisely what they want.** Saved views accept either a
filter panel or a Boolean query (`@Renault AND (recall OR defect) AND
lang:fr`), with entity mentions resolved against Wikidata.

**Keeps what matters.** Stories can be bookmarked, filed into folders and
followed. Notifications are opt-in per story — never a firehose of
everything that moved.

**Signal — agents that triage.** A reader writes their context once (who
they are, what their desk covers) and creates agents, each with a short
request in plain language. On every worker pass, each agent reads the
stories that received new articles from the monitors it watches and
returns a verdict — kept or dropped — with a one-sentence reason and,
when it can, an excerpt quoted from the articles. The Decisions screen
lists stories, not verdicts, and says why an agent did not judge one:
out of its scope, still waiting, or beyond its daily budget. An agent
judges only what arrives after it was created.

## How it is built

```
┌──────────────────────────┐   ┌──────────────────────┐   ┌──────────────────┐
│  Worker — ~8 min loop    │   │  FastAPI             │   │  Next.js 16      │
│                          │──▶│                      │◀──│                  │
│  collect → normalize     │   │  reads, user actions │   │  /watch          │
│  → extract → entities    │   │  /admin              │   │  /library        │
│  → embed → cluster       │   │  /mcp for assistants │   │  /monitors       │
│  → story state → judge   │   │                      │   │  /signal         │
│  → translate → notify    │   │                      │   │  /settings       │
└──────────────────────────┘   └──────────────────────┘   └──────────────────┘
              │                           │                        │
              ▼                           ▼                        ▼
             ┌──────────────────────────────────────────────────────┐
             │  Postgres — pgvector, pg_cron, unaccent, RLS         │
             │  Supabase Auth (ES256 via JWKS) and Realtime         │
             └──────────────────────────────────────────────────────┘
                              + OpenAI  + Resend
```

The worker and the API are separate processes sharing one database. The
worker never serves a request, and the API does not call a model to
answer one: what it returns was computed ahead of time, so a page load is
a few database reads. Each worker step is isolated — one failing step is
reported and the rest of the pass still runs — and an advisory lock keeps
two passes from overlapping.

What gets fetched follows who reads. A reader follows entries of a
curated catalogue; each entry is fetched by one **monitor** that every
reader of it shares, so a source followed by a hundred people is fetched
once, and one nobody follows is not fetched at all. A monitor is built
from a **template** — plain RSS or a Google News query today — which
only fetches; attribution, deduplication, storage and health are handled
the same way for every template (`src/collector.py`), so adding one is a
package under `src/templates/` and nothing else.

An MCP server sits alongside the API, exposing the same corpus as tools
an AI assistant can call — search stories, inspect an article, follow a
story — over stdio or HTTP.

## Stack

**Backend** — Python 3.12, FastAPI, psycopg2, feedparser, OpenAI SDK,
Resend. **Frontend** — Next.js 16 App Router, TypeScript, Tailwind v4,
shadcn on Base UI, next-intl (English and French). **Data** — Postgres
with pgvector (HNSW), pg_cron and unaccent, Supabase Auth and Realtime.
**Quality** — pytest and ruff on the backend, Vitest and Testing Library
on the frontend, both enforced in CI.

## Running it

You will need a Postgres database with the `pgvector`, `pg_cron` and
`unaccent` extensions — Supabase provides all three — plus an OpenAI key.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements_dev.txt
cp .env.example .env               # then fill it in
cp webapp/.env.example webapp/.env.local
```

Both example files list every variable with what it is for. Apply the
migrations in order — `migrations/0001_baseline.sql`, then each later
`NNNN_*.sql` — through the Supabase SQL editor, or with
`python scripts/apply_migrations.py`. Start the API once: on an empty
database it seeds the catalogue from `config/catalog.json`. Then:

```bash
uvicorn src.api:app --reload --port 8000   # API
python -m src.runner                       # ingest worker
cd webapp && npm install && npm run dev    # frontend
```

## Tests

```bash
pytest && ruff check .                                  # backend
cd webapp && npm test && npm run lint && npm run typecheck
```

Neither suite touches the network or a database: the backend tests cover
pure logic, the frontend tests mock the API layer. CI runs both, plus a
production build.

## Repository

```
src/            pipeline steps, loaders, auth, notifications
src/templates/  how each kind of monitor is fetched
src/routes/     HTTP routes, one router per domain
mcp_server/     MCP tools for AI assistants
migrations/     the schema: one baseline, then versioned SQL
scripts/        CLI entry points — each docstring says what it is for
webapp/         Next.js frontend
tests/          backend tests; frontend tests sit next to their component
```

## Some decisions, and why

| Decision | Reasoning |
|---|---|
| RSS over a search API | An early version ran on a search API. It worked, but cost scaled with every query and the sources could not be pinned down. RSS is cheap, and the reader picks the sources. |
| Incremental clustering over hierarchical | Hierarchical clustering needs the whole corpus to re-run. A feed that never stops needs an algorithm that never restarts. |
| Stories only, no themes | A second clustering layer grouped stories into themes. It added a concept to explain and a pass to maintain, and nobody could say what it was for. Removed. |
| One call per story for its text | Label, synthesis and timeline are kept by one call that sees the new articles only, so the cost follows what arrives, not the size of the story. |
| Agents give a reason, not a score | A score has to be trusted; a sentence can be checked. An excerpt the articles do not contain is dropped rather than shown. |
| A daily budget per agent | An agent that reads everything costs without limit. When the budget cannot reach a story while it is fresh, the story is listed as skipped, so the reader sees what was missed and can narrow the agent. |
| Notifications are opt-in per story | Being told about everything produces noise nobody reads. A bell on one story is a statement of intent. |
| `pg_cron` over an external scheduler | The retention job is a few SQL statements. Giving it its own service would have been more infrastructure than logic. |
| Authorisation as middleware | Forty write endpoints, each with its own guard, means the forty-first is open by accident. Refusing by default inverts the cost of forgetting. |

## Licence

All rights reserved — see [LICENSE](LICENSE). The code is published to be
read; anything else is a short email away.
