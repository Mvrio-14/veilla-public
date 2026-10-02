"""
Helpers every loader shares: parsing the JSON the database hands back,
ordering by recency, and choosing the title and summary a reader is shown
in their language.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from src.languages import PIPELINE_LANGUAGE


def parse_category(raw) -> list[str]:
    # `items.category` is native JSONB, so
    # psycopg2 may hand us a Python list/dict directly. Older code
    # paths (or other callers feeding a string) still go through the
    # json.loads() branch.
    if raw is None or raw == "":
        return ["Other"]
    if isinstance(raw, list):
        return raw or ["Other"]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return parsed or ["Other"]
            return [parsed] if parsed else ["Other"]
        except Exception:
            return [raw]
    # dict / other JSON scalar → wrap into a single-element list
    return [str(raw)]


def parse_json_field(v) -> dict:
    """
    Defensive JSON dict parser for the *_translations columns.

    Postgres returns JSONB columns as already-parsed dicts via psycopg2,
    while TEXT columns storing JSON come back as strings. We have a mix
    in the schema right now (`title_translations` = TEXT, `summary_
    translations` = JSONB), so this helper handles both transparently.
    """
    if v is None or v == "":
        return {}
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def parse_json_list(v) -> list:
    """
    Same defensive idea as `parse_json_field` but for JSON arrays
    (e.g. the `feeds_list` aggregation produced by `json_agg`).
    """
    if v is None or v == "":
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, str):
        try:
            parsed = json.loads(v)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def dedup_feeds(feeds: list[dict]) -> list[dict]:
    """
    Drop duplicate feed entries from a `feeds_list` aggregation.

    The aggregate groups by canonical key, and two items sharing one can
    have been delivered by the same monitor, which it then lists twice.
    """
    seen: set[int] = set()
    out: list[dict] = []
    for f in feeds:
        fid = f.get("id")
        if fid is None or fid in seen:
            continue
        seen.add(fid)
        out.append(f)
    return out


# Sentinel for articles missing every timestamp — sorts as "oldest" so they
# fall to the bottom of recency-DESC orderings (the same effect the old ""
# string fallback had back when these columns were TEXT).
_DT_MIN = datetime.min.replace(tzinfo=timezone.utc)


def _as_dt(value) -> datetime | None:
    """Coerce a DB timestamp to a tz-aware datetime, or None.

    items.published_at / fetched_at are TIMESTAMPTZ,
    so psycopg2 hands us datetimes. We still accept ISO strings defensively
    (legacy rows, tests) and force UTC on any naive value so comparisons and
    max() never mix offset-aware and naive datetimes.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(value)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def pub_sort_key(a: dict) -> datetime:
    """Recency key: published_at, else fetched_at, else oldest-possible."""
    return _as_dt(a.get("published_at")) or _as_dt(a.get("fetched_at")) or _DT_MIN


def cluster_recency_max(story: dict) -> datetime:
    """Cluster recency = max published_at across its articles. Bubbles
    a story up when a fresh article attaches. Lifted to module scope
    so the /watch endpoint's pagination cursor can use the EXACT same
    ordering as the sort inside `load_watch`."""
    articles = story.get("articles") or []
    if not articles:
        return _DT_MIN
    return max(pub_sort_key(a) for a in articles)


def resolve_display_title(
    article: dict,
    output_lang: str,
) -> tuple[str, bool]:
    """
    Pick the title to show this user, no LLM. Returns (title, is_translated).

    `is_translated` is True when the title shown is not the original —
    the SPA uses it to decide whether to render the source-language chip
    on the row ("translated from FR").

    Rules, in order:
      - If src_lang == output_lang → use the RAW source title (the
        original RSS title in source lang). The frontend runs
        decodeHtmlEntities on it, so HTML noise is cleaned client-side.
        NOT translated, no chip.
      - Elif the reader reads English → title_normalized, the
        normaliser's English, is their translation; nothing else is
        written for them.
      - Elif a cached translation exists for output_lang → use it (translated).
      - Else fallback to title_normalized (the canonical EN version produced
        by the normalizer). Better than nothing when the worker's translator
        step hasn't caught up yet — and serves EN users directly.

    Important: title_normalized is ALWAYS canonical EN (the normalizer
    translates everything to English for downstream label/cluster
    consistency). Returning it as-is to a non-EN user would be wrong,
    hence the branch on src_lang == output_lang here.

    Performance: the cached translation arrives
    pre-extracted from Postgres in `article["title_for_user_lang"]`
    (a single string or None) rather than as a full dict — the loader
    queries `title_translations ->> output_lang` directly (native JSONB
    — no cast needed). This
    keeps the resolution logic unchanged but cuts ~80% of the per-
    article bytes shipped from Postgres → Python.
    """
    src_lang = (article.get("lang") or "").lower()
    raw_title    = article.get("title") or ""
    canonical_en = article.get("title_normalized") or raw_title

    if src_lang and src_lang == output_lang:
        return raw_title or canonical_en, False

    if output_lang == PIPELINE_LANGUAGE:
        return canonical_en, True

    cached = article.get("title_for_user_lang")
    if cached:
        return cached, True

    return canonical_en, False


def resolve_display_summary(
    article: dict,
    output_lang: str,
) -> tuple[str, bool]:
    """
    Same rules as `resolve_display_title` but on the summary.

    summary_normalized is ALWAYS canonical EN (the normalizer translates
    everything for downstream consistency). For a same-lang user we return
    the raw `summary` (in source lang); for a different-lang user we return
    the cached translation if present, else fallback to canonical EN.

    See `resolve_display_title` for the SQL-side extraction note.
    """
    src_lang = (article.get("lang") or "").lower()
    raw_summary  = article.get("summary") or ""
    canonical_en = article.get("summary_normalized") or raw_summary

    if src_lang and src_lang == output_lang:
        return raw_summary or canonical_en, False

    if output_lang == PIPELINE_LANGUAGE:
        return canonical_en, True

    cached = article.get("summary_for_user_lang")
    if cached:
        return cached, True

    return canonical_en, False
