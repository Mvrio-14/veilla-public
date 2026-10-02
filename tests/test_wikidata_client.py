"""
Tests for `wikidata_client` — focused on the canonical-label picker
since that's where entity-display bugs live.

The picker is the only piece we exercise here because the rest of
`enrich()` is a thin wrapper around the Wikidata HTTP API: testing
it meaningfully would require mocking `_get_json` and recording real
responses, which is more brittle than valuable. The picker is the
sole transformation step where domain logic lives, so it's the
fixable / regressable surface.
"""
from __future__ import annotations

from src.wikidata_client import _pick_canonical_label

# ── Happy path ────────────────────────────────────────────────────────


def test_prefers_en_when_present() -> None:
    # The textbook case: Wikidata returns an `"en"` label, we use it.
    labels = {
        "en": {"value": "Donald Trump"},
        "ru": {"value": "Дональд Трамп"},
        "mul": {"value": "Trump"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"


def test_falls_back_to_mul_when_no_en() -> None:
    # Real-world case: Q22686 has NO `"en"`
    # entry. Wikidata stores the universal latin form once as `"mul"`
    # ("multiple languages") and uses per-language transliterations for
    # everything else. Picker must reach the `"mul"` label before the
    # alphabetical fallback, otherwise we land on the cyrillic
    # `"ab"` (Abkhaz) entry that sorts first alphabetically.
    labels = {
        "ab":  {"value": "Дональд Трамп"},
        "ja":  {"value": "ドナルド・トランプ"},
        "mul": {"value": "Donald Trump"},
        "ru":  {"value": "Дональд Трамп"},
        "zh":  {"value": "唐納·川普"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"


def test_falls_back_alphabetically_when_neither_en_nor_mul() -> None:
    # No `"en"`, no `"mul"` — last-resort deterministic fallback to the
    # first non-empty key in alphabetic order. "ja" sorts before "ru".
    labels = {
        "ru": {"value": "Эпизод"},
        "ja": {"value": "エピソード"},
    }
    assert _pick_canonical_label(labels) == "エピソード"


# ── Defensive: empty / missing / blank inputs ─────────────────────────


def test_returns_none_on_empty_dict() -> None:
    assert _pick_canonical_label({}) is None


def test_skips_empty_string_values() -> None:
    # A label entry with an empty `"value"` shouldn't be picked — fall
    # through to the next candidate. Wikidata occasionally returns
    # placeholder rows for in-progress translations.
    labels = {
        "en":  {"value": ""},
        "mul": {"value": "Donald Trump"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"


def test_skips_whitespace_only_values() -> None:
    labels = {
        "en":  {"value": "   "},
        "mul": {"value": "Donald Trump"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"


def test_returns_none_when_all_values_blank() -> None:
    labels = {
        "en":  {"value": ""},
        "mul": {"value": "   "},
        "ru":  {"value": None},
    }
    assert _pick_canonical_label(labels) is None


def test_tolerates_malformed_label_entry() -> None:
    # Wikidata's API is stable but we still guard against a row missing
    # the inner `"value"` key (could happen with a partial response or
    # a future schema tweak). Just skip it, don't crash.
    labels = {
        "en":  {},                          # no "value" key
        "mul": {"value": "Donald Trump"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"


def test_tolerates_non_string_value_type() -> None:
    # An "en" entry where value is e.g. an int (shouldn't happen, but)
    # is treated as missing so we move on rather than returning garbage.
    labels = {
        "en":  {"value": 42},
        "mul": {"value": "Donald Trump"},
    }
    assert _pick_canonical_label(labels) == "Donald Trump"
