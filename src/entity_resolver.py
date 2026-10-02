"""
Entity resolver — worker step between `extract` and `embed`.

Reads each freshly-extracted article's `entities` JSONB (the LLM's
typed entity dump produced by `extractor.py`) and links every mention
to a row in the canonical `entities` table, writing the link in
`item_entities`. The article is then stamped with
`entities_resolved_at = NOW()` so it doesn't get reprocessed.

The full resolution algorithm per mention:

    1. **Local cache** — SELECT from `entities` where the surface is in
       the row's `aliases` array AND the kind matches. Hit → done in
       one DB round-trip, no network, no LLM. This carries 90%+ of the
       load in steady state.

    2. **Wikidata search** — `wbsearchentities` with the surface form.
       Returns up to 5 candidates.

    3. **Top-1 unambiguous** — if the top candidate's score gap over
       #2 is wide (or there's only one), accept it. We then `enrich`
       to fetch full metadata and persist.

    4. **LLM disambiguate** — if ≥2 candidates are tight, ask the LLM
       which one fits the article context. If confidence ≥ floor,
       persist. Otherwise mark as unlinked.

    5. **Unlinked** — Wikidata returned nothing OR LLM was unsure. We
       still INSERT a row into `entities` with `wikidata_id = NULL` and
       `source = 'unlinked'` so the mention is still queryable and so
       it can be manually curated later via /admin/entities.

# Concurrency model

Articles are processed in a ThreadPool of `_PARALLELISM=8` workers.
Each thread:

    - Acquires its OWN psycopg2 connection from the pool (psycopg2
      conns are not safe across threads).
    - Runs the per-article transaction end-to-end (cache lookups,
      Wikidata calls, LLM disambiguation, INSERTs) and commits.
    - Releases the connection on exit.

This gives us:
    - Worker-level parallelism (multiple articles in flight)
    - Independent per-article transactions (one slow article doesn't
      block the others' commits)
    - Natural backpressure via the Wikidata client's semaphore (8
      simultaneous Wikidata calls max — see `wikidata_client.py`)

# Race conditions on shared entities

If two threads concurrently encounter the same NEW entity ("Macron"
appears in two articles processed in parallel), both will hit Wikidata,
both will get Q3052772, both will try to INSERT. We handle this with
`ON CONFLICT (wikidata_id) DO UPDATE SET … RETURNING id` so the second
INSERT just fetches the first one's id without erroring.

For unlinked entities (no `wikidata_id` to ON CONFLICT on) we accept
that two threads can create two near-duplicate unlinked rows in rare
races. That's a curation problem for the admin UI, not a runtime bug.

# Aliases growth strategy

Every time we link a mention to an existing entity, we append the
mention's surface form to that entity's `aliases` if not already
present. So as the corpus grows, the cache catches more and more
variants ("Trump", "Donald J. Trump", "DJT", "le président américain")
without us hard-coding them.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed

from openai import OpenAI

from src.db import get_connection
from src.entity_disambiguator import (
    CONFIDENCE_FLOOR,
    disambiguate,
)
from src.entity_disambiguator import MODEL as DISAMBIGUATION_MODEL
from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.observability import capture_step_failure
from src.wikidata_client import (
    WikidataCandidate,
    WikidataEntity,
)
from src.wikidata_client import (
    enrich as wikidata_enrich,
)
from src.wikidata_client import (
    search as wikidata_search,
)
from src.wikidata_client import (
    search_full_text as wikidata_search_full_text,
)

_log = logging.getLogger(__name__)


# How many articles to resolve per worker pass. Caps the work each tick
# so we never starve the rest of the pipeline. With ~50 articles/pass
# typical and ~5-15 mentions each, this is ~500 mention lookups/pass —
# 90%+ hit the local cache so the actual Wikidata + LLM load is small.
_DEFAULT_LIMIT = 200

# Parallelism across articles. Each worker owns one DB connection
# (db.py's pool has maxconn=30, well above this number).
_PARALLELISM = 8


# Mapping from extractor's JSONB bucket names → our `entities.kind`
# values. The extractor uses plurals; the DB uses singulars.
_BUCKET_TO_KIND = {
    "persons":   "person",
    "orgs":      "org",
    "locations": "location",
    "events":    "event",
    "markets":   "market",
    "products":  "product",
}


def _canonicalize(s: str) -> str:
    """Same canonicalization the extractor does: strip accents, collapse
    whitespace, trim common trailing punctuation. Used at cache lookup
    time so "Macron" and "Macron." match the same alias entry.

    NUL stripping is defensive: LLM extractor output occasionally leaks
    embedded 0x00 bytes (seen on article 4744001 with surface
    "Hy\\x00eres"). NFD-normalize and `encode("ascii", "ignore")` both
    treat NUL as a valid character and preserve it, so it would reach
    psycopg2 which rejects NUL in string literals. Same defense as the
    `REPLACE(entities, '\\u0000', '')` in `watch_aggregations.py`.
    """
    s = s.replace("\x00", "")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(".,;:'\"")
    return s


def _parse_entities_jsonb(raw) -> list[tuple[str, str, int]]:
    """Parse the extractor's `entities` JSONB into (surface, kind, salience).

    Surface form salience: the extractor ranks within each bucket
    (capped at 3 per bucket). We map rank-0 → salience 5, rank-1 → 4,
    rank-2 → 3.

    Returns an EMPTY list on any parse failure — the article is then
    silently stamped as "resolved with zero mentions", which is the
    right behavior for articles whose extractor pass produced
    malformed output.
    """
    if raw is None:
        return []
    # The DB column is JSONB but psycopg2 may return either a dict or
    # the raw JSON string depending on driver settings.
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            return []
    if not isinstance(raw, dict):
        return []

    out: list[tuple[str, str, int]] = []
    for bucket, items in raw.items():
        kind = _BUCKET_TO_KIND.get(bucket)
        if kind is None or not isinstance(items, list):
            continue
        for rank, item in enumerate(items):
            if not isinstance(item, str):
                continue
            surface = _canonicalize(item)
            if not surface:
                continue
            salience = max(1, 5 - rank)
            out.append((surface, kind, salience))
    return out


def _lookup_cached(cur, surface: str, kind: str) -> int | None:
    """Local cache lookup via the GIN aliases index.

    We use `WHERE %s = ANY(aliases)` which the GIN index serves cheaply
    AND case-insensitively via ILIKE? No — that's an exact match. We
    match on the canonical_label too in case the alias array is empty
    on a manually-created entity.

    Returns the entities.id (resolving through cluster_id if the row is
    a known duplicate) or None if no cache hit.
    """
    cur.execute(
        """
        SELECT COALESCE(cluster_id, id) AS canonical_id
          FROM entities
         WHERE kind = %s
           AND status = 'active'
           AND (%s = ANY(aliases) OR LOWER(canonical_label) = LOWER(%s))
         LIMIT 1
        """,
        (kind, surface, surface),
    )
    row = cur.fetchone()
    return int(row[0]) if row else None


def _persist_entity_from_wikidata(
    cur, *, kind: str, wikidata_entity: WikidataEntity, surface: str,
) -> int:
    """Upsert a row in `entities` for a Wikidata-resolved entity.

    Idempotent thanks to ON CONFLICT (wikidata_id). The CONFLICT branch
    appends the new surface form to the aliases array if not present —
    which is how the cache grows organically as the corpus expands.
    """
    aliases_payload = list(wikidata_entity.aliases)
    if surface and surface not in aliases_payload:
        aliases_payload.append(surface)

    label_translations_json = json.dumps(
        wikidata_entity.label_translations, ensure_ascii=False
    )

    cur.execute(
        """
        INSERT INTO entities
            (wikidata_id, kind, canonical_label, description, country,
             instance_of, industry, aliases, label_translations, image_url,
             source, last_refreshed_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s,
                'wikidata', NOW())
        ON CONFLICT (wikidata_id) DO UPDATE
            SET aliases = (
                  SELECT ARRAY(SELECT DISTINCT unnest(
                    entities.aliases || EXCLUDED.aliases
                  ))
                ),
                updated_at = NOW()
            RETURNING id
        """,
        (
            wikidata_entity.qid,
            kind,
            wikidata_entity.canonical_label,
            wikidata_entity.description,
            wikidata_entity.country,
            list(wikidata_entity.instance_of),
            wikidata_entity.industry,
            aliases_payload,
            label_translations_json,
            wikidata_entity.image_url,
        ),
    )
    row = cur.fetchone()
    if row is None:
        # ON CONFLICT DO UPDATE always RETURNs in Postgres ≥9.5; this
        # branch is defensive in case a future migration changes the
        # ON CONFLICT target and silently breaks the return.
        cur.execute(
            "SELECT id FROM entities WHERE wikidata_id = %s",
            (wikidata_entity.qid,),
        )
        row = cur.fetchone()
    return int(row[0])


def _persist_unlinked(cur, surface: str, kind: str) -> int:
    """Insert (or return existing) row for a mention we couldn't link
    to Wikidata.

    Best-effort dedup by (canonical_label, kind) WHERE wikidata_id IS
    NULL: if a previous mention with the same surface and kind was
    already stored as unlinked, reuse it. Loose because we don't have
    a UNIQUE index on that — concurrent inserts can race — but it's
    cheap and catches the common case.
    """
    cur.execute(
        """
        SELECT id FROM entities
         WHERE wikidata_id IS NULL
           AND status = 'active'
           AND kind = %s
           AND LOWER(canonical_label) = LOWER(%s)
         LIMIT 1
        """,
        (kind, surface),
    )
    row = cur.fetchone()
    if row:
        return int(row[0])

    cur.execute(
        """
        INSERT INTO entities
            (kind, canonical_label, aliases, source, status)
        VALUES (%s, %s, %s, 'unlinked', 'active')
        RETURNING id
        """,
        (kind, surface, [surface]),
    )
    return int(cur.fetchone()[0])


# Per-kind "description keywords that mean this candidate is NOT of
# the expected kind". Used to reject obvious mismatches without an
# extra LLM call. We're conservative — only reject when the
# description CONTAINS one of these as a strong signal.
#
# Why this matters: Wikipedia's title resolution for "Apple" returns
# the FRUIT (Q89) as the canonical meaning. If our extractor said
# kind=org, taking the fruit is wrong. This filter forces a fallback
# to the search step (which gives us Apple Inc. + the fruit as
# candidates) and lets the LLM disambiguator pick the right one.
_KIND_REJECT_DESCRIPTION_KEYWORDS = {
    "person":   ("edible fruit", "plant species", "city", "country",
                 "river", "mountain", "diacritical", "calendar era",
                 "musical instrument", "currency", "stock market",
                 "writing system", "computer hardware", "video game"),
    "org":      ("edible fruit", "fruit", "plant species", "diacritical",
                 "musical instrument", "writing system", "calendar era",
                 "first name", "given name", "family name", "surname",
                 "river in", "mountain in", "city in", "village in",
                 "personhood", "actor (", "actress (", "born "),
    "location": ("first name", "given name", "family name", "surname",
                 "edible fruit", "plant species", "calendar era",
                 "actor (", "actress (", "born ", "company",
                 "corporation", "musical instrument"),
    "event":    ("first name", "given name", "family name", "surname",
                 "city", "country", "river", "mountain", "person",
                 "company", "corporation", "edible fruit",
                 "actor", "actress", "born "),
    "market":   ("first name", "given name", "family name", "actor",
                 "actress", "born ", "edible fruit", "city in",
                 "country", "musical instrument"),
    "product":  ("first name", "given name", "family name", "actor",
                 "actress", "born ", "city in", "village in",
                 "country", "calendar era"),
}


def _description_matches_kind(description: str | None, kind: str) -> bool:
    """Cheap heuristic: does the Wikidata description suggest this
    candidate is of the right kind? Returns True (allow) unless there's
    strong evidence of a mismatch.

    The goal is to filter the bluntly-wrong cases (Apple-the-fruit when
    we said kind=org) without trying to be too clever. The LLM
    disambiguator handles the subtler cases downstream.
    """
    if not description:
        return True  # no info → assume OK, let downstream decide
    desc = description.lower()
    rejects = _KIND_REJECT_DESCRIPTION_KEYWORDS.get(kind, ())
    return not any(kw in desc for kw in rejects)


def _resolve_one_mention(
    cur,
    *,
    client:      OpenAI,
    surface:     str,
    kind:        str,
    article_lang: str,
    article_title: str,
    article_summary: str | None,
) -> tuple[int | None, dict]:
    """Resolve a single (surface, kind) mention to an entity_id.

    Flow (4 layers, ordered by cost):

      1. **Local cache** (single DB query). Hit → done in microseconds.
      2. **Wikipedia search** (`src.wikidata_client.search`). Returns
         either a single direct title hit OR a top-N candidate list.
      3. **Filtering**: drop disambig pages + obvious kind mismatches.
         If a single real candidate remains → take it (no LLM call).
      4. **LLM disambiguator** (only when ≥ 2 real candidates remain).

    Returns (entity_id, stats) where stats carries the call counters
    and outcome label for the step-level aggregation.
    """
    stats = {
        "cache_hit":      False,
        "wikidata_calls": 0,
        "llm_calls":      0,
        "input_tokens":   0,
        "output_tokens":  0,
        "outcome":        "unlinked",  # cached/direct/filtered/disambiguated/unlinked
    }

    # 1. Local cache.
    hit_id = _lookup_cached(cur, surface, kind)
    if hit_id is not None:
        stats["cache_hit"] = True
        stats["outcome"]   = "cached"
        return hit_id, stats

    # 2. Wikipedia search (does direct title resolve + falls back to
    # full-text search if needed, see wikidata_client.search docstring).
    candidates = wikidata_search(
        surface, kind, lang=(article_lang or "en"), limit=5,
    )
    stats["wikidata_calls"] += 1  # 1-2 actual HTTP calls inside search()

    if not candidates:
        return _persist_unlinked(cur, surface, kind), stats

    # 3. Filter: drop disambig pages + kind mismatches.
    def _filter(cs: list[WikidataCandidate]) -> list[WikidataCandidate]:
        return [
            c for c in cs
            if not c.is_disambiguation_page
            and _description_matches_kind(c.description, kind)
        ]

    real_candidates = _filter(candidates)

    # If the filter killed everything AND we only had 1 candidate
    # (= direct title resolution returned Wikipedia's primary meaning,
    # which doesn't match our kind — e.g. "Apple" → fruit when we want
    # org), retry with the full-text search path to find alternatives.
    if not real_candidates and len(candidates) == 1:
        candidates = wikidata_search_full_text(
            surface, kind, lang=(article_lang or "en"), limit=5,
        )
        stats["wikidata_calls"] += 1
        real_candidates = _filter(candidates)

    if not real_candidates:
        return _persist_unlinked(cur, surface, kind), stats

    # If exactly one real candidate remains → take it directly. This is
    # the dominant fast path: Wikipedia's title resolution gave us a
    # clean hit, no LLM needed.
    if len(real_candidates) == 1:
        only = real_candidates[0]
        enriched = wikidata_enrich(only.qid, kind=kind)
        stats["wikidata_calls"] += 1
        if enriched is None:
            return _persist_unlinked(cur, surface, kind), stats
        stats["outcome"] = "direct"
        return _persist_entity_from_wikidata(
            cur, kind=kind, wikidata_entity=enriched, surface=surface,
        ), stats

    # 4. ≥ 2 real candidates → LLM disambiguator picks one with article
    # context. The disambiguator may return None if confidence is low
    # — in that case we mark unlinked rather than guessing.
    result = disambiguate(
        client          = client,
        surface         = surface,
        kind            = kind,
        candidates      = real_candidates,
        article_title   = article_title,
        article_summary = article_summary,
    )
    stats["llm_calls"]    += 1
    stats["input_tokens"] += result.input_tokens
    stats["output_tokens"] += result.output_tokens
    # Persist the disambiguation call. `cur.connection` gives us the
    # worker's own psycopg2 conn (each article-resolver has its own —
    # see `_resolve_one_article`), safe to write from this thread.
    if result.model is not None:
        log_llm_call(
            cur.connection, model=result.model, step="resolve_entities",
            purpose=f"disambiguate_{kind}",
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            duration_ms=result.duration_ms,
            success=(result.qid is not None or "LLM error" not in result.reasoning),
            error=(result.reasoning if "LLM error" in result.reasoning else None),
        )

    if result.qid is None or result.confidence < CONFIDENCE_FLOOR:
        return _persist_unlinked(cur, surface, kind), stats

    enriched = wikidata_enrich(result.qid, kind=kind)
    stats["wikidata_calls"] += 1
    if enriched is None:
        return _persist_unlinked(cur, surface, kind), stats

    stats["outcome"] = "disambiguated"
    return _persist_entity_from_wikidata(
        cur, kind=kind, wikidata_entity=enriched, surface=surface,
    ), stats


def _resolve_one_article(article: dict, client: OpenAI) -> dict:
    """Process a single article end-to-end on its own DB connection.

    Returns aggregated stats for the step-level counters.
    """
    article_id   = article["id"]
    entities_raw = article.get("entities")
    title        = article.get("title_normalized") or article.get("title") or ""
    summary      = article.get("summary_full") or article.get("summary_normalized")
    lang         = article.get("lang") or "en"

    mentions = _parse_entities_jsonb(entities_raw)

    agg = {
        "article_id":     article_id,
        "n_mentions":     len(mentions),
        "n_cached":       0,
        "n_unambiguous":  0,
        "n_disambiguated":0,
        "n_unlinked":     0,
        "wikidata_calls": 0,
        "llm_calls":      0,
        "input_tokens":   0,
        "output_tokens":  0,
        "error":          None,
    }

    conn = get_connection()
    try:
        cur = conn.cursor()

        # Resolve mentions sequentially within the article (only ~5-15
        # mentions, sequential keeps the per-mention cache state
        # consistent without locking). Parallelism is across articles.
        for surface, kind, salience in mentions:
            try:
                entity_id, mstats = _resolve_one_mention(
                    cur,
                    client          = client,
                    surface         = surface,
                    kind            = kind,
                    article_lang    = lang,
                    article_title   = title,
                    article_summary = summary,
                )
            except Exception as e:
                # Single-mention failure shouldn't abort the article —
                # log + Sentry, then move on (the mention is dropped
                # this pass; the article will still be stamped
                # resolved). We send to Sentry as a degraded step
                # (`capture_step_failure`) so a wave of failures (e.g.
                # Wikidata API change) generates a single grouped issue
                # rather than 1k duplicate stack traces.
                _log.warning(
                    "resolve_one_mention error article=%s surface=%r kind=%s: %s",
                    article_id, surface, kind, e,
                )
                capture_step_failure(
                    "resolve_entities",
                    f"mention failure article={article_id} surface={surface!r} "
                    f"kind={kind}: {type(e).__name__}: {e}",
                )
                continue

            agg["wikidata_calls"] += mstats["wikidata_calls"]
            agg["llm_calls"]      += mstats["llm_calls"]
            agg["input_tokens"]   += mstats["input_tokens"]
            agg["output_tokens"]  += mstats["output_tokens"]
            if mstats["outcome"] == "cached":           agg["n_cached"]        += 1
            elif mstats["outcome"] == "direct":         agg["n_unambiguous"]   += 1
            elif mstats["outcome"] == "disambiguated":  agg["n_disambiguated"] += 1
            else:                                       agg["n_unlinked"]      += 1

            if entity_id is None:
                continue

            # Link this article to the resolved entity. ON CONFLICT DO
            # NOTHING handles the "same mention appears twice in the
            # bucket" edge case (the extractor dedupes but be safe).
            cur.execute(
                """
                INSERT INTO item_entities
                    (item_id, entity_id, salience, surface_form, kind_at_match)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (item_id, entity_id) DO NOTHING
                """,
                (article_id, entity_id, salience, surface, kind),
            )

        # Mark the article as resolved EVEN IF some mentions failed —
        # we don't want to re-process the whole article on the next
        # pass for a single flaky mention.
        cur.execute(
            "UPDATE items SET entities_resolved_at = NOW() WHERE id = %s",
            (article_id,),
        )
        conn.commit()
    except Exception as e:
        # Whole-article failure — report it once, then bail. The article
        # is NOT stamped resolved, so the next pass retries it.
        agg["error"] = repr(e)
        capture_step_failure(
            "resolve_entities",
            f"article failure id={article_id}: {type(e).__name__}: {e}",
        )
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return agg


def resolve_pending(
    conn,
    client: OpenAI,
    limit: int | None = None,
) -> dict:
    """Resolve entities for every article that has `entities` JSONB set
    but no `entities_resolved_at` yet.

    Args:
        conn  : DB connection (used ONLY for the initial SELECT and the
                aggregate cost UPDATE). Workers borrow their own conns
                from the pool — see module docstring on concurrency.
        client: OpenAI client (shared across workers — the SDK is
                thread-safe).
        limit : optional cap on # articles per pass (defaults to
                `_DEFAULT_LIMIT`).

    Returns:
        Stats dict with keys consumed by the runner's step logging:
        `{"articles": int, "mentions": int, "wikidata_calls": int,
          "llm_calls": int, "cost": float}`.
    """
    limit = int(limit) if limit else _DEFAULT_LIMIT

    cur = conn.cursor()
    cur.execute(
        """
        SELECT a.id, a.title, a.title_normalized, a.summary_normalized,
               a.summary_full, a.lang, a.entities
          FROM items a
         WHERE a.entities IS NOT NULL
           AND a.entities_resolved_at IS NULL
           AND a.archive_seed = FALSE
         ORDER BY a.fetched_at DESC
         LIMIT %s
        """,
        (limit,),
    )
    rows = cur.fetchall()
    if not rows:
        return {
            "articles":       0,
            "mentions":       0,
            "wikidata_calls": 0,
            "llm_calls":      0,
            "cost":           0.0,
        }

    articles = [
        {
            "id":                 r[0],
            "title":              r[1],
            "title_normalized":   r[2],
            "summary_normalized": r[3],
            "summary_full":       r[4],
            "lang":               r[5],
            "entities":           r[6],
        }
        for r in rows
    ]

    n_total = len(articles)
    print(f"  Resolving entities for {n_total} article(s) — {_PARALLELISM}-way parallel...")

    totals = {
        "articles":        0,
        "mentions":        0,
        "n_cached":        0,
        "n_unambiguous":   0,
        "n_disambiguated": 0,
        "n_unlinked":      0,
        "wikidata_calls":  0,
        "llm_calls":       0,
        "input_tokens":    0,
        "output_tokens":   0,
    }
    totals_lock = threading.Lock()

    with ThreadPoolExecutor(
        max_workers      = _PARALLELISM,
        thread_name_prefix = "entity-resolver",
    ) as pool:
        futures = {
            pool.submit(_resolve_one_article, a, client): a["id"]
            for a in articles
        }
        for fut in as_completed(futures):
            article_id = futures[fut]
            try:
                agg = fut.result()
            except Exception as e:
                _log.warning("resolve_one_article fatal: id=%s err=%s",
                             article_id, e)
                continue
            with totals_lock:
                totals["articles"]        += 1
                totals["mentions"]        += agg["n_mentions"]
                totals["n_cached"]        += agg["n_cached"]
                totals["n_unambiguous"]   += agg["n_unambiguous"]
                totals["n_disambiguated"] += agg["n_disambiguated"]
                totals["n_unlinked"]      += agg["n_unlinked"]
                totals["wikidata_calls"]  += agg["wikidata_calls"]
                totals["llm_calls"]       += agg["llm_calls"]
                totals["input_tokens"]    += agg["input_tokens"]
                totals["output_tokens"]   += agg["output_tokens"]

    cost = estimate_cost(
        DISAMBIGUATION_MODEL,
        input_tokens=totals["input_tokens"], output_tokens=totals["output_tokens"],
    )

    print(
        f"  Resolved {totals['articles']} article(s), "
        f"{totals['mentions']} mention(s): "
        f"cached={totals['n_cached']} "
        f"unambig={totals['n_unambiguous']} "
        f"disambig={totals['n_disambiguated']} "
        f"unlinked={totals['n_unlinked']} "
        f"(wd={totals['wikidata_calls']} llm={totals['llm_calls']} "
        f"cost=${cost:.4f})"
    )

    return {
        "articles":        totals["articles"],
        "mentions":        totals["mentions"],
        "wikidata_calls":  totals["wikidata_calls"],
        "llm_calls":       totals["llm_calls"],
        "cached":          totals["n_cached"],
        "unambiguous":     totals["n_unambiguous"],
        "disambiguated":   totals["n_disambiguated"],
        "unlinked":        totals["n_unlinked"],
        "cost":            cost,
    }


def _refresh_one_entity(entity_row: dict) -> dict:
    """Re-fetch a single entity from Wikidata and update its row.

    Each call uses its own DB connection so this function is safe to
    fire in parallel from a ThreadPool (same model as
    `_resolve_one_article`).
    """
    entity_id   = entity_row["id"]
    wikidata_id = entity_row["wikidata_id"]
    kind        = entity_row["kind"]

    stats = {"refreshed": 0, "skipped": 0, "errors": 0,
             "wikidata_calls": 0, "id": entity_id}

    if not wikidata_id:
        # Unlinked rows have no Wikidata source to refresh from.
        stats["skipped"] = 1
        return stats

    try:
        enriched = wikidata_enrich(wikidata_id, kind=kind)
        stats["wikidata_calls"] = 1
    except Exception as e:
        capture_step_failure(
            "refresh_entities",
            f"wikidata fetch failed for id={entity_id} qid={wikidata_id}: "
            f"{type(e).__name__}: {e}",
        )
        stats["errors"] = 1
        return stats

    if enriched is None:
        # Wikidata transient miss — mark refreshed anyway so we don't
        # pick the same row again on every pass. The data we already
        # have stays valid until the next refresh cycle.
        conn = get_connection()
        try:
            conn.cursor().execute(
                "UPDATE entities SET last_refreshed_at = NOW() WHERE id = %s",
                (entity_id,),
            )
            conn.commit()
        finally:
            conn.close()
        stats["skipped"] = 1
        return stats

    # Merge new aliases with existing ones (don't drop user-added or
    # extractor-grown aliases) and rewrite the canonical fields.
    label_translations_json = json.dumps(
        enriched.label_translations, ensure_ascii=False
    )
    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE entities
               SET canonical_label    = %s,
                   description        = %s,
                   country            = %s,
                   instance_of        = %s,
                   industry           = %s,
                   aliases            = (
                     SELECT ARRAY(SELECT DISTINCT unnest(
                       entities.aliases || %s::text[]
                     ))
                     FROM entities WHERE id = %s
                   ),
                   label_translations = %s::jsonb,
                   image_url          = %s,
                   last_refreshed_at  = NOW(),
                   updated_at         = NOW()
             WHERE id = %s
            """,
            (
                enriched.canonical_label,
                enriched.description,
                enriched.country,
                list(enriched.instance_of),
                enriched.industry,
                list(enriched.aliases),
                entity_id,
                label_translations_json,
                enriched.image_url,
                entity_id,
            ),
        )
        conn.commit()
        stats["refreshed"] = 1
    except Exception as e:
        capture_step_failure(
            "refresh_entities",
            f"DB update failed for id={entity_id} qid={wikidata_id}: "
            f"{type(e).__name__}: {e}",
        )
        stats["errors"] = 1
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return stats


# How stale before we re-pull. 30d is conservative: most Wikidata
# changes that matter for us (role changes, dissolutions) happen on
# news cycles slower than that. Halve if/when we notice users
# complaining about stale descriptions.
_REFRESH_STALE_AFTER = "30 days"

# Max entities to refresh per pass. Bounds the work each worker pass
# spends on refresh so it doesn't starve the rest of the pipeline. With
# ~6 passes/hour, 30/pass = 180/hour = ~4300/day. For most setups,
# refresh catches up to "all fresh" within a day, then self-throttles
# (the WHERE clause excludes recently-refreshed rows).
_REFRESH_BATCH_SIZE = 30


def refresh_stale_entities(conn, batch_size: int | None = None) -> dict:
    """Re-fetch Wikidata payload for entities whose data is older than
    `_REFRESH_STALE_AFTER`.

    Self-throttling: the WHERE clause filters out fresh rows, so once
    the whole table is up-to-date this returns immediately with
    {refreshed: 0}. We don't need an external schedule — each worker
    pass calls this, but only does work when something is actually
    stale.

    Run AFTER `resolve_pending` in the worker so a new article's
    just-created entities don't immediately get picked as "stale"
    candidates (NULL last_refreshed_at). We treat NULL as "never
    refreshed" only if the row's `created_at` is also older than the
    window — otherwise we leave it alone for the next cycle.
    """
    n = int(batch_size or _REFRESH_BATCH_SIZE)
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT id, wikidata_id, kind
          FROM entities
         WHERE status = 'active'
           AND wikidata_id IS NOT NULL
           AND (
                  (last_refreshed_at IS NOT NULL
                   AND last_refreshed_at < NOW() - INTERVAL '{_REFRESH_STALE_AFTER}')
               OR (last_refreshed_at IS NULL
                   AND created_at        < NOW() - INTERVAL '{_REFRESH_STALE_AFTER}')
         )
         ORDER BY COALESCE(last_refreshed_at, created_at) ASC
         LIMIT %s
        """,
        (n,),
    )
    rows = cur.fetchall()
    if not rows:
        return {
            "candidates":     0,
            "refreshed":      0,
            "skipped":        0,
            "errors":         0,
            "wikidata_calls": 0,
        }

    entity_rows = [
        {"id": r[0], "wikidata_id": r[1], "kind": r[2]}
        for r in rows
    ]
    print(f"  Refreshing {len(entity_rows)} stale entit(ies)...")

    totals = {
        "candidates":     len(entity_rows),
        "refreshed":      0,
        "skipped":        0,
        "errors":         0,
        "wikidata_calls": 0,
    }
    totals_lock = threading.Lock()

    # Same parallelism as the resolver — 8 in-flight Wikidata calls is
    # well below the API's polite ceiling.
    with ThreadPoolExecutor(
        max_workers      = _PARALLELISM,
        thread_name_prefix = "entity-refresh",
    ) as pool:
        futures = [pool.submit(_refresh_one_entity, row) for row in entity_rows]
        for fut in as_completed(futures):
            try:
                s = fut.result()
            except Exception as e:
                _log.warning("refresh worker crashed: %s", e)
                with totals_lock:
                    totals["errors"] += 1
                continue
            with totals_lock:
                totals["refreshed"]      += s["refreshed"]
                totals["skipped"]        += s["skipped"]
                totals["errors"]         += s["errors"]
                totals["wikidata_calls"] += s["wikidata_calls"]

    print(
        f"  Refreshed {totals['refreshed']}/{totals['candidates']} entit(ies) "
        f"(skipped={totals['skipped']} errors={totals['errors']} "
        f"wd={totals['wikidata_calls']})"
    )
    return totals


__all__ = ["resolve_pending", "refresh_stale_entities"]
