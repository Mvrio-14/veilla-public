"""
Adversarial test suite for the Boolean query parser + compiler.

# What this covers

The parser is luqum (trusted upstream), so we don't test ITS parsing
correctness. We test OUR compilation logic — the AST→SQL transformer
— against:

  - Operator precedence (AND vs OR vs NOT)
  - Nested groups
  - Field modifiers we registered (title, lang, category, country, entity)
  - Wildcards (`*` suffix) and phrase queries
  - Negation chains
  - Empty / whitespace / parse-error inputs
  - Unknown fields (should fall through to free-text, not crash)

# What we don't test here

  - Real-DB execution semantics (= integration test, not unit test).
    The /me/query/test endpoint exercises that path manually.
  - Token escaping for tsquery (= the `_word_to_tsquery_atom` private
    helper has its own dedicated cases inline below).

Run via `pytest tests/test_boolean_query.py -v`.
"""
from __future__ import annotations

import pytest

from src.boolean_query import (
    BooleanQueryError,
    _word_to_tsquery_atom,  # noqa
    compile_to_where,
    parse,
)

# ── Smoke / happy path ──────────────────────────────────────────────────


def test_empty_input_returns_no_filter() -> None:
    sql, params = compile_to_where(parse(""))
    assert sql == "TRUE"
    assert params == []


def test_whitespace_only_returns_no_filter() -> None:
    sql, params = compile_to_where(parse("   "))
    assert sql == "TRUE"
    assert params == []


def test_single_bare_word_emits_fts() -> None:
    sql, params = compile_to_where(parse("Renault"))
    assert "search_vector @@ to_tsquery" in sql
    assert params == ["simple", "Renault"]


def test_phrase_emits_phraseto_tsquery() -> None:
    sql, params = compile_to_where(parse('"perte de contrôle"'))
    assert "phraseto_tsquery" in sql
    # Quotes stripped + accents folded — the GIN search_vector is
    # built on `immutable_unaccent(...)` so query
    # tokens must be unaccented too to hit the index.
    assert "perte de controle" in params


def test_wildcard_becomes_prefix_match() -> None:
    sql, params = compile_to_where(parse("universit*"))
    # Postgres tsquery prefix syntax is `<atom>:*`
    assert "universit:*" in params


# ── Operator precedence ─────────────────────────────────────────────────


def test_AND_combines_with_explicit_AND() -> None:
    sql, _ = compile_to_where(parse("A AND B"))
    assert " AND " in sql


def test_OR_combines_with_explicit_OR() -> None:
    sql, _ = compile_to_where(parse("A OR B"))
    assert " OR " in sql


def test_NOT_emits_negation() -> None:
    sql, _ = compile_to_where(parse("NOT sport"))
    assert sql.startswith("NOT (")


def test_nested_groups_preserve_precedence() -> None:
    sql, params = compile_to_where(parse("(A OR B) AND C"))
    # OR group must be wrapped before being AND'd with C.
    assert " OR " in sql
    assert " AND " in sql
    # Three FTS atoms (one for each Word).
    assert params.count("simple") == 3


def test_NOT_inside_AND_only_negates_its_subtree() -> None:
    sql, _ = compile_to_where(parse("A AND NOT B"))
    # The NOT must be local to B; the A term must NOT be negated.
    parts = sql.split(" AND ")
    assert any(p.startswith("(NOT") or "NOT (" in p for p in parts)
    assert not all("NOT" in p for p in parts)


# ── Field modifiers ─────────────────────────────────────────────────────


def test_lang_field_maps_to_a_lang_column() -> None:
    sql, params = compile_to_where(parse("lang:fr"))
    assert "a.lang = %s" in sql
    assert "fr" in params


def test_lang_is_lowercased() -> None:
    sql, params = compile_to_where(parse("lang:EN"))
    assert "en" in params


def test_country_field_maps_to_sources_alias() -> None:
    # The country: filter requires the caller to have joined `sources s`.
    sql, params = compile_to_where(parse("country:fr"))
    assert "s.country = %s" in sql
    # Country codes are upper-cased server-side.
    assert "FR" in params


def test_category_field_uses_jsonb_membership() -> None:
    sql, params = compile_to_where(parse("category:Politics"))
    assert "category" in sql and "?" in sql
    assert "Politics" in params


def test_title_field_uses_ilike() -> None:
    sql, params = compile_to_where(parse("title:Renault"))
    # title: matches BOTH the original `title` and the LLM-normalised
    # EN `title_normalized`, both wrapped in `immutable_unaccent`
    # so the search is accent-insensitive on the
    # multilang corpus.
    assert "immutable_unaccent(a.title)" in sql
    assert "immutable_unaccent(a.title_normalized)" in sql
    assert "ILIKE" in sql
    assert "%Renault%" in params


def test_entity_qid_joins_item_entities() -> None:
    sql, params = compile_to_where(parse("entity:Q22686"))
    assert "item_entities" in sql
    assert "wikidata_id = %s" in sql
    assert "Q22686" in params


def test_entity_invalid_qid_falls_through_to_freetext() -> None:
    # `entity:foobar` (not a Q-id) → free-text on the value, NOT a
    # silent match-everything.
    sql, params = compile_to_where(parse("entity:foobar"))
    assert "item_entities" not in sql
    assert "foobar" in params


def test_unknown_field_falls_through_to_freetext() -> None:
    sql, params = compile_to_where(parse("randomfield:value"))
    assert "search_vector @@ to_tsquery" in sql
    assert "value" in params


# ── Composition ─────────────────────────────────────────────────────────


def test_mixed_fts_and_structured_combine_cleanly() -> None:
    sql, params = compile_to_where(parse('Renault AND lang:fr AND entity:Q22687'))
    assert "search_vector @@" in sql
    assert "a.lang = %s" in sql
    assert "item_entities" in sql
    assert "Renault" in params
    assert "fr" in params
    assert "Q22687" in params


def test_OR_of_entities() -> None:
    sql, params = compile_to_where(parse("entity:Q22686 OR entity:Q3052772"))
    assert sql.count("item_entities") == 2
    assert "Q22686" in params and "Q3052772" in params
    assert " OR " in sql


def test_NOT_with_field_negates_correctly() -> None:
    sql, _ = compile_to_where(parse("NOT lang:en"))
    assert "NOT (" in sql
    assert "a.lang = %s" in sql


# ── Parse errors ────────────────────────────────────────────────────────


def test_dangling_AND_raises_BooleanQueryError() -> None:
    with pytest.raises(BooleanQueryError):
        parse("Renault AND")


def test_unclosed_paren_raises_BooleanQueryError() -> None:
    with pytest.raises(BooleanQueryError):
        parse("(Renault AND rappel")


def test_unclosed_quote_raises_BooleanQueryError() -> None:
    with pytest.raises(BooleanQueryError):
        parse('Renault AND "perte de')


# ── Implicit AND (no operator between terms) ────────────────────────────


def test_adjacent_words_treated_as_AND() -> None:
    """Lucene's default operator is AND when no operator is given.
    luqum represents this as UnknownOperation; we compile it as AND."""
    sql, params = compile_to_where(parse("Renault rappel"))
    assert " AND " in sql
    assert "Renault" in params and "rappel" in params


# ── tsquery atom escaping ───────────────────────────────────────────────


def test_word_to_tsquery_atom_strips_unsafe_chars() -> None:
    # Postgres tsquery hates &|!()<>: — they must be stripped from atom.
    assert _word_to_tsquery_atom("foo&bar") == "foobar"
    assert _word_to_tsquery_atom("foo:bar") == "foobar"


def test_word_to_tsquery_atom_strips_accents() -> None:
    # Accents are folded so the atom matches the unaccented index
    # (search_vector is built via `immutable_unaccent`).
    # Without this, querying "café" never matches the indexed "cafe".
    assert _word_to_tsquery_atom("café") == "cafe"
    # Non-Latin scripts have no combining marks — preserved as-is.
    assert _word_to_tsquery_atom("москва") == "москва"


def test_word_to_tsquery_atom_handles_wildcard() -> None:
    assert _word_to_tsquery_atom("test*") == "test:*"


def test_word_to_tsquery_atom_handles_empty_input() -> None:
    assert _word_to_tsquery_atom("") == "__noop__"
    # All-special-chars input → noop, not crash.
    assert _word_to_tsquery_atom("&&&") == "__noop__"


# ── Defensive: weird but legal inputs ───────────────────────────────────


def test_deep_nesting_doesnt_crash() -> None:
    q = "((A AND B) OR (C AND D)) AND (E OR (F AND NOT G))"
    sql, params = compile_to_where(parse(q))
    assert sql  # didn't crash
    assert len(params) >= 7   # 7 distinct atoms (FTS + lang param pair counts)


def test_double_negation_collapses_to_plain_match() -> None:
    # Our compiler tracks the `negated` flag through Not nodes — two
    # NOT flips cancel out, so `NOT NOT X` compiles to the same SQL
    # as `X`. Semantically correct (¬¬x = x) AND avoids redundant
    # `NOT (NOT (...))` in EXPLAIN output. Free win.
    sql_double, _ = compile_to_where(parse("NOT NOT Renault"))
    sql_plain,  _ = compile_to_where(parse("Renault"))
    assert sql_double == sql_plain
    assert "NOT" not in sql_double


# ── NEAR / proximity (`"phrase"~N`) ───────────────────────────────────


def test_two_word_proximity_emits_bidirectional_tsquery() -> None:
    # `"Macron inflation"~5` → tsquery with both orders OR'd so the
    # match is order-agnostic (the Lucene/Brandwatch convention).
    sql, params = compile_to_where(parse('"Macron inflation"~5'))
    assert "to_tsquery" in sql
    # tsquery payload is the second param after the FTS config name.
    assert params[0] == "simple"
    tsq = params[1]
    # Bidirectional shape: both orderings present, joined by `|`.
    assert "Macron <5> inflation" in tsq
    assert "inflation <5> Macron" in tsq
    assert "|" in tsq


def test_three_word_proximity_emits_pairwise_AND() -> None:
    # `"a b c"~5` → AND of three bidirectional pair-NEARs:
    # (a<>b OR b<>a) AND (a<>c OR c<>a) AND (b<>c OR c<>b).
    sql, params = compile_to_where(parse('"alpha beta gamma"~5'))
    tsq = params[1]
    # All three pairs must be present.
    for a, b in [("alpha", "beta"), ("alpha", "gamma"), ("beta", "gamma")]:
        assert f"{a} <5> {b}" in tsq
        assert f"{b} <5> {a}" in tsq
    # AND'd together — there should be at least two ` & ` separators
    # for three pair-clauses.
    assert tsq.count(" & ") == 2


def test_proximity_strips_accents_to_match_unaccented_index() -> None:
    # Same migration-0056 rule as bare Phrase: accents are folded so
    # the tokens hit the index built via `immutable_unaccent`.
    sql, params = compile_to_where(parse('"récession européenne"~3'))
    tsq = params[1]
    assert "recession" in tsq
    assert "europeenne" in tsq
    assert "récession" not in tsq


def test_single_word_proximity_degenerates_to_freetext() -> None:
    # `"Macron"~5` makes no semantic sense (slop needs ≥2 words). Fall
    # back to the same FTS atom a bare `Macron` would emit, rather
    # than silently no-op'ing.
    sql, params = compile_to_where(parse('"Macron"~5'))
    # Plain to_tsquery, no `<N>` operator — same shape as a Word.
    assert "to_tsquery" in sql
    assert "<5>" not in params[1]
    assert "Macron" in params[1]


def test_proximity_with_negation() -> None:
    # `NOT "Macron inflation"~5` → wraps the proximity expression in
    # `NOT (...)` so the outer combine logic still flips correctly.
    # The `<5>` operator lives inside the tsquery PARAM (the SQL just
    # has `to_tsquery(%s, %s)`), so check params, not the SQL string.
    sql, params = compile_to_where(parse('NOT "Macron inflation"~5'))
    assert sql.startswith("NOT (")
    assert "<5>" in params[-1]


def test_proximity_inside_AND() -> None:
    sql, params = compile_to_where(parse('lang:fr AND "Macron inflation"~3'))
    assert "a.lang = %s" in sql
    assert "<3>" in params[-1]   # last tsquery param holds the proximity


def test_proximity_zero_slop_falls_through_to_true() -> None:
    # `"foo bar"~0` — the parser accepts it but proximity-zero is
    # meaningless (use plain `"foo bar"` for strict). We refuse to
    # silently change semantics; emit TRUE so the rest of the query
    # still runs.
    sql, _ = compile_to_where(parse('"foo bar"~0'))
    assert sql == "TRUE"


# ── Custom column aliases (denormalised temp tables) ───────────────────


def test_feed_filter_uses_custom_feed_name_sql() -> None:
    # When the caller has the feed name materialised on a temp table
    # (e.g. `u.feed_name` in `_watch_universe`), it can pass the column
    # expression instead of going through `monitor_items`.
    sql, params = compile_to_where(
        parse('feed:"Le Monde"'),
        feed_name_sql="u.feed_name",
    )
    assert "u.feed_name = %s" in sql
    assert "monitor_items" not in sql
    assert "Le Monde" in params


def test_country_filter_uses_custom_source_country_sql() -> None:
    sql, params = compile_to_where(
        parse("country:fr"),
        source_country_sql="u.source_country",
    )
    assert "u.source_country = %s" in sql
    assert "s.country" not in sql
    assert "FR" in params


def test_defaults_when_overrides_omitted() -> None:
    # A caller that overrides nothing matches a feed on the first monitor
    # that delivered the item — no join needed on its side — and a
    # country on `sources s`.
    sql_feed, params = compile_to_where(parse('feed:"Le Monde"'))
    assert "FROM monitor_items mi" in sql_feed
    assert "WHERE mi.item_id = a.id ORDER BY mi.fetched_at" in sql_feed
    assert sql_feed.endswith("LIMIT 1) = %s")
    assert params == ["Le Monde"]
    sql_country, _ = compile_to_where(parse("country:fr"))
    assert "s.country = %s" in sql_country


def test_article_alias_propagates_to_custom_handlers() -> None:
    # When `alias` is overridden, the article-side fields still use it
    # (lang, category, …) even with custom feed/source overrides set.
    sql, _ = compile_to_where(
        parse("lang:fr AND feed:reuters"),
        alias="u",
        feed_name_sql="u.feed_name",
    )
    assert "u.lang = %s" in sql
    assert "u.feed_name = %s" in sql
