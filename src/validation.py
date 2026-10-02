"""
LLM output validation.

The normalizer + extractor LLM calls return JSON objects whose shape we
trust the model to follow most of the time but never assume. A merely
*tolerant* parser drops invalid values to defaults with no trace, so the
cost of a regressing prompt or a model behavior shift stays invisible
until someone happens to look at a row.

This module is the canonical place where we:
  - filter every LLM-emitted field against its taxonomy (categories,
    article_type, country codes, lang, entity types);
  - drop empty / duplicate / over-quota entries;
  - report each dropped field to Sentry as a structured `validation_warning`
    breadcrumb so we can spot prompt drift in aggregate (one Sentry
    issue per (call, field) pair via `fingerprint`).

Design choice:
  - drop invalid fields silently in the row (= keep the article ingestable),
  - log to Sentry for visibility,
  - reject the article entirely only when the JSON itself is malformed
    (handled upstream in normalizer / extractor before this module is
    even called).

`record_validation_warning` is the single sink for Sentry signal so
adding a new validator anywhere in the codebase doesn't need to
re-implement the breadcrumb/fingerprint plumbing.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from src.taxonomy import (
    CATEGORIES,
    VALID_ARTICLE_TYPES,
    VALID_CATEGORY_INDICES,
    VALID_COUNTRY_CODES,
    VALID_ENTITY_TYPES,
)

# Soft caps. The extractor's prompt asks for ≤3 per entity type, ≤8
# keywords, ≤5 countries, ≤2 categories — these are the runtime
# enforcers in case the model overshoots.
MAX_ENTITIES_PER_TYPE = 3
MAX_KEYWORDS          = 8
MAX_COUNTRIES         = 5
MAX_CATEGORIES        = 2

# Soft minimums. A "feature"-formatted prompt that returns 0 categories
# is suspicious but legal; we don't enforce a minimum (silent drops are
# preferable to false article rejections).


# ── Sentry sink ────────────────────────────────────────────────────────
def record_validation_warning(
    call: str,
    field: str,
    article_id: int | None,
    detail: str,
) -> None:
    """Report a single LLM validation drop to Sentry.

    `call` is the source step ("normalize" | "extract" | "renormalize").
    `field` is the field whose value was rejected.
    `article_id` is the row identifier (may be None when validating an
    in-memory batch before a row id is known).
    `detail` is a short human-readable explanation.

    Grouped via `fingerprint=[call, field]` so all drops on the same
    field land in one Sentry issue regardless of article id. No-op
    when Sentry isn't initialised — silent in dev, visible in prod.
    """
    # Import lazily — `src.observability` initialises Sentry; importing
    # it from here unconditionally would couple every CLI script that
    # touches the normalizer to the observability stack.
    try:
        from src.observability import _INITIALISED
    except Exception:
        return
    if not _INITIALISED:
        return
    try:
        import sentry_sdk
    except ImportError:
        return

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("validation_call", call)
        scope.set_tag("validation_field", field)
        if article_id is not None:
            scope.set_extra("article_id", article_id)
        scope.set_extra("detail", detail)
        scope.fingerprint = ["llm-validation-warning", call, field]
        sentry_sdk.capture_message(
            f"[{call}] {field} drop: {detail}",
            level="warning",
        )


# ── Field validators ───────────────────────────────────────────────────
def validate_lang(raw: Any, call: str, article_id: int | None) -> str | None:
    """Return a clean lowercase ISO 639-1 2-letter code or None."""
    if not isinstance(raw, str):
        if raw is not None:
            record_validation_warning(
                call, "lang", article_id, f"non-string ({type(raw).__name__})"
            )
        return None
    s = raw.strip().lower()
    if len(s) == 2 and s.isalpha():
        return s
    if s:
        record_validation_warning(
            call, "lang", article_id, f"non-conforming code {s!r}"
        )
    return None


def validate_article_type(raw: Any, call: str, article_id: int | None) -> str | None:
    """Return the article_type if it's in the whitelist, else None."""
    if not isinstance(raw, str):
        if raw is not None:
            record_validation_warning(
                call, "article_type", article_id, f"non-string ({type(raw).__name__})"
            )
        return None
    s = raw.strip().lower()
    if s in VALID_ARTICLE_TYPES:
        return s
    if s:
        record_validation_warning(
            call, "article_type", article_id, f"unknown value {s!r}"
        )
    return None


def validate_categories(raw: Any, call: str, article_id: int | None) -> list[str]:
    """Filter to integers in 1..N, return up to MAX_CATEGORIES category names.

    The LLM is asked to emit integer indices into `CATEGORIES`. We
    convert to canonical English names here so downstream code never
    has to know the index/name mapping.
    """
    if not isinstance(raw, list):
        if raw is not None:
            record_validation_warning(
                call, "categories", article_id, f"non-list ({type(raw).__name__})"
            )
        return []
    out: list[str] = []
    dropped: list = []
    for v in raw:
        if isinstance(v, int) and v in VALID_CATEGORY_INDICES:
            out.append(CATEGORIES[v - 1])
        else:
            dropped.append(v)
    if dropped:
        record_validation_warning(
            call, "categories", article_id,
            f"dropped out-of-range items: {dropped!r}"
        )
    return out[:MAX_CATEGORIES]


def validate_keywords(raw: Any, call: str, article_id: int | None) -> list[str]:
    """Trim + dedupe + cap at MAX_KEYWORDS. Drop empty strings."""
    if not isinstance(raw, list):
        if raw is not None:
            record_validation_warning(
                call, "keywords", article_id, f"non-list ({type(raw).__name__})"
            )
        return []
    seen: set[str] = set()
    out: list[str] = []
    for v in raw:
        s = str(v).strip()
        if not s:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out[:MAX_KEYWORDS]


def validate_countries(raw: Any, call: str, article_id: int | None) -> list[str]:
    """Filter to codes in `VALID_COUNTRY_CODES`, cap at MAX_COUNTRIES.

    The LLM occasionally emits the 2-letter regional aliases we
    deprecated (`EU`, `ME`, etc. — they collided with real ISO alpha-2
    codes); those land as the real country codes (Montenegro, etc.)
    and we report them via Sentry so we can iterate the prompt if it
    happens often.
    """
    if not isinstance(raw, list):
        if raw is not None:
            record_validation_warning(
                call, "countries", article_id, f"non-list ({type(raw).__name__})"
            )
        return []
    seen: set[str] = set()
    out: list[str] = []
    dropped: list = []
    for v in raw:
        if not isinstance(v, str):
            dropped.append(v)
            continue
        s = v.strip().upper()
        if not s:
            continue
        if s not in VALID_COUNTRY_CODES:
            dropped.append(v)
            continue
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    if dropped:
        record_validation_warning(
            call, "countries", article_id,
            f"dropped {len(dropped)} invalid code(s): {dropped[:5]!r}"
        )
    return out[:MAX_COUNTRIES]


def validate_entities(
    raw: Any,
    call: str,
    article_id: int | None,
    keep_org: Callable[[str], bool] | None = None,
) -> dict[str, list[str]]:
    """Sanitize the entities object.

    Returns a dict shaped `{"persons": [], "orgs": [], "locations": [],
    "events": [], "markets": [], "products": []}`, each list capped at
    `MAX_ENTITIES_PER_TYPE` after dedup. Unknown keys in `raw` are
    discarded with a Sentry warning. `keep_org` is a per-article filter
    applied to the `orgs` list (used to drop the article's own
    publisher and bare country names).
    """
    out: dict[str, list[str]] = {t: [] for t in VALID_ENTITY_TYPES}
    if not isinstance(raw, dict):
        if raw is not None:
            record_validation_warning(
                call, "entities", article_id, f"non-dict ({type(raw).__name__})"
            )
        return out

    unknown_keys = [k for k in raw.keys() if k not in VALID_ENTITY_TYPES]
    if unknown_keys:
        record_validation_warning(
            call, "entities", article_id,
            f"unknown entity types: {unknown_keys!r}"
        )

    for etype in VALID_ENTITY_TYPES:
        items = raw.get(etype, [])
        if not isinstance(items, list):
            if items:
                record_validation_warning(
                    call, f"entities.{etype}", article_id,
                    f"non-list ({type(items).__name__})"
                )
            continue
        seen: set[str] = set()
        cleaned: list[str] = []
        for e in items:
            s = str(e).strip()
            if not s:
                continue
            key = s.lower()
            if key in seen:
                continue
            if etype == "orgs" and keep_org is not None and not keep_org(s):
                continue
            seen.add(key)
            cleaned.append(s)
        out[etype] = cleaned[:MAX_ENTITIES_PER_TYPE]

    return out
