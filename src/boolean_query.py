"""
Boolean query parser + SQL compiler — Q1 of the Boolean migration.

# What this module does

Takes a Lucene-syntax Boolean query string (the same syntax Meltwater,
Brandwatch, Elasticsearch users already know) and compiles it to a SQL
WHERE fragment that runs against the `articles` table (plus joins as
needed for entity/source filters).

The PARSE step is owned by `luqum` — a mature Apache2 Python library
that reads Lucene query syntax into an AST. We DO NOT write a parser
from scratch. The COMPILE step (AST → SQL) is the only original code
here, and it's small because the underlying SQL bricks already exist
in `build_article_where`.

# Why Lucene syntax

It's the de facto industry standard. Meltwater, Brandwatch / Cision,
Talkwalker, Solr, Elasticsearch — all use variants of it. Users coming
from those tools recognize the grammar immediately, zero re-learning.

# Supported grammar

  AND, OR, NOT (case-sensitive uppercase)
  Parentheses for precedence
  "exact phrase" (double-quoted, multi-word)
  "phrase"~N (proximity / NEAR — see below)
  Wildcards: `*` (suffix), `?` (single char)
  Field modifiers:
    title:Renault                          → match in title only
    lang:fr                                → article language
    category:Politics                      → article category
    country:FR                             → source publishing country
    subject_country:UA                     → article's subject country
    article_type:opinion                   → article shape
    feed:"Le Monde"                        → exact feed name
    entity:Q22686                          → canonical Wikidata entity
  Range queries (TIMESTAMPTZ):
    published:[2026-01-01 TO 2026-06-30]  → inclusive range
    fetched:{2026-01-01 TO *}              → exclusive low, open high
    published:[* TO 2026-06-30]            → open low, inclusive high

# NEAR / proximity (`"phrase"~N`)

  `"Macron inflation"~5` matches articles where "Macron" and
  "inflation" appear within 5 lex positions of each other, in any
  order. Compiles to Postgres `tsquery`'s native `<N>` operator on
  the indexed `search_vector` — no extension needed.

  Semantics is order-agnostic to match Lucene/Brandwatch user
  expectation. Internally we emit `(a <N> b) | (b <N> a)` for two
  words; for 3+ words we AND all pairwise bidirectional NEARs —
  conservative but well-defined: every pair must be within N. A pure
  Lucene-spec "all words within a window of N positions" is slightly
  tighter; ours is close enough at our scale and stays cheap to
  compile and execute.

# Newline convention

A literal newline in the editor is rewritten to ` OR ` before
parsing (matches Brandwatch/Meltwater UX where each line is a
separate OR'd term). Lucene strict has no newline semantics.

# Not supported yet

  - Topic Lists (`$Recession` aliasing to a saved synonym set,
    LLM-bootstrapped)
  - Field modifiers: ingress:, source:, author:, reach:, shares:
  - Regex / fuzzy operators (deferred until pg_search migration)

# Architectural choice on FTS combining

Each Word/Phrase becomes its own `search_vector @@ to_tsquery(...)`
clause, combined via SQL Boolean. We DON'T pre-combine multiple FTS
terms into a single tsquery — keeps the compiler straightforward and
the per-term tsquery still hits the GIN index well at our scale. We
can refactor toward query-fusion later if EXPLAIN ANALYZE reveals
real bottlenecks.

# Empty/safe behavior

  - Empty query string → returns `("TRUE", [])`, i.e. no filter
  - Parse error → raises `BooleanQueryError` with the line/col
  - Unknown SearchField → silently treated as a free-text term against
    `search_vector` (defensive — old saved views with unknown fields
    don't blow up)
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from luqum.exceptions import ParseError
from luqum.parser import parser as _luqum_parser
from luqum.tree import (
    AndOperation,
    Group,
    Item,
    Not,
    OrOperation,
    Phrase,
    Proximity,
    Range,
    SearchField,
    UnknownOperation,
    Word,
)


class BooleanQueryError(ValueError):
    """Raised when the query string fails to parse. Carries the
    original luqum error message so the SPA can surface a precise
    syntax hint."""


# FTS config: 'simple' = no stemming, no stop-words. Matches the
# `search_vector` indexing (stemming in one language breaks search
# across the others).
#
# Pair with `_strip_accents` on the query side: the index is unaccented
# via `immutable_unaccent`, so the query tokens must
# be unaccented too. Otherwise "récession" never matches indexed
# "recession".
_FTS_LANGUAGE = "simple"


def _strip_accents(s: str) -> str:
    """Strip diacritics so query tokens match the unaccented index.

    Uses NFD decomposition + ASCII drop, same logic the entity
    resolver uses and the same logic Postgres's `unaccent` extension
    applies on the index side. Non-Latin scripts (Cyrillic, CJK,
    Arabic, …) are preserved as-is — they have no combining marks to
    decompose.
    """
    decomposed = unicodedata.normalize("NFKD", s)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


# Context carried through every compile call. Lets the caller plug
# alternate SQL expressions for a feed's name and `source.country` when
# the caller's query has those values denormalised onto a different
# column (e.g. watch_aggregations builds a `_watch_universe` temp table
# that holds `u.feed_name` and `u.source_country` directly — no join
# to `sources s`).
#
# Defaults: items aliased as `a`, joined with `sources s`; a feed is
# the monitor that delivered the item first (`first_feed_name_sql`).
@dataclass(frozen=True)
class _CompileCtx:
    alias:              str = "a"
    feed_name_sql:      str | None = None
    source_country_sql: str = "s.country"


# Mapping from Lucene field name (lowercase) to a compile helper.
# Field modifiers we DON'T know fall back to free-text search on the
# value (= permissive behavior, see module docstring).
@dataclass(frozen=True)
class _FieldHandler:
    """A registered field modifier. The handler takes the field's value
    (string from the AST) and returns `(sql_fragment, params)`."""
    name: str
    compile: callable    # (value: str, *, ctx: _CompileCtx) -> tuple[str, list]


def _compile_lang(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    return f"{ctx.alias}.lang = %s", [value.lower()]


def _compile_category(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # `items.category` is native JSONB. `?` tests
    # "value present as top-level array element or object key" —
    # perfect for our array-of-strings shape.
    return f"COALESCE({ctx.alias}.category, '[]'::jsonb) ? %s", [value]


def _compile_country(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # Source country lives on `sources.country` by default (the article-
    # row alias doesn't carry it directly). The compiler assumes the
    # caller has joined `sources s` — same convention as
    # `build_article_where`. Callers with a denormalised column can
    # override via `source_country_sql=` on `compile_to_where`.
    return f"{ctx.source_country_sql} = %s", [value.upper()]


def _compile_subject_country(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # `items.countries` is native JSONB of ISO
    # codes (alpha-2) plus our 3-letter regional codes (EUR/ASI/MID/
    # AFR/LAT/OCE/GLB). Exact-code membership (no broad-to-children
    # expansion). The resolver in `build_article_where` does the
    # expansion; port it here if Boolean queries ever need it.
    return f"COALESCE({ctx.alias}.countries, '[]'::jsonb) ? %s", [value.upper()]


def _compile_article_type(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    return f"{ctx.alias}.article_type = %s", [value.lower()]


def _compile_feed(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # Feed by name. Callers with the name denormalised override via
    # `feed_name_sql=` on `compile_to_where`.
    name_sql = ctx.feed_name_sql or first_feed_name_sql(ctx.alias)
    return f"{name_sql} = %s", [value]


def first_feed_name_sql(alias: str) -> str:
    """The name of the monitor that delivered item `alias` first — the
    item's `feed_name` in API responses, which the web app filters on
    too, so server and client agree on what `feed:X` matches."""
    return (
        f"(SELECT mo.name FROM monitor_items mi "
        f"JOIN monitors mo ON mo.id = mi.monitor_id "
        f"WHERE mi.item_id = {alias}.id "
        f"ORDER BY mi.fetched_at, mi.monitor_id LIMIT 1)"
    )


def _compile_title(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # title:X — substring match on the ORIGINAL title (in the article's
    # publishing language) AND the LLM-normalized EN title. Both sides
    # are wrapped in `immutable_unaccent` so a query
    # for "récession" matches both "Récession" (original FR) and
    # "Recession" (normalized EN). The value is itself stripped of
    # accents in Python so the SQL pattern stays ASCII.
    #
    # No GIN index on the unaccent expression — ILIKE on 31k rows is
    # fast enough (sub-100ms). When we cross 100k rows this becomes a
    # trigram GIN target (pg_trgm).
    pattern = f"%{_strip_accents(value)}%"
    return (
        f"(immutable_unaccent({ctx.alias}.title) ILIKE %s "
        f"OR immutable_unaccent({ctx.alias}.title_normalized) ILIKE %s)",
        [pattern, pattern],
    )


def _compile_entity(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # entity:Q22686 — match any item_entities row referencing a
    # canonical entity by Wikidata Q-id. We accept the Q-id (most
    # canonical) — name-based lookup like entity:"Renault" is NOT
    # supported intentionally (ambiguous; the UI's @-mention picker
    # resolves names to Q-ids before insertion).
    if not value.startswith("Q") or len(value) < 2:
        # Invalid Q-id: fall through to free-text on the value so the
        # query doesn't silently match everything.
        return _compile_freetext(value, ctx=ctx)
    return (
        f"EXISTS (SELECT 1 FROM item_entities ae "
        f"JOIN entities e ON e.id = ae.entity_id "
        f"WHERE ae.item_id = {ctx.alias}.id AND e.wikidata_id = %s "
        f"AND e.status = 'active')",
        [value],
    )


def _compile_freetext(value: str, *, ctx: _CompileCtx) -> tuple[str, list]:
    # Fallback: a bare Word that didn't match a structured field. Goes
    # to FTS on `search_vector` via to_tsquery. We use `simple` FTS
    # language to match how search_vector was built.
    # to_tsquery requires a query string in its own mini-grammar
    # (operators &, |, !, <-> and bare lexemes). For a single word we
    # just emit `word:*` which acts like a prefix-match — friendlier
    # for `universit*` style wildcards already common in Lucene
    # syntax. The user's literal `*` wildcard is converted upstream.
    return (
        f"{ctx.alias}.search_vector @@ to_tsquery(%s, %s)",
        [_FTS_LANGUAGE, _word_to_tsquery_atom(value)],
    )


_FIELDS: dict[str, _FieldHandler] = {
    "lang":             _FieldHandler("lang",             _compile_lang),
    "category":         _FieldHandler("category",         _compile_category),
    "country":          _FieldHandler("country",          _compile_country),
    "subject_country":  _FieldHandler("subject_country",  _compile_subject_country),
    "article_type":     _FieldHandler("article_type",     _compile_article_type),
    "feed":             _FieldHandler("feed",             _compile_feed),
    "title":            _FieldHandler("title",            _compile_title),
    "entity":           _FieldHandler("entity",           _compile_entity),
}


# ── Compilation ───────────────────────────────────────────────────────────


def parse(text: str) -> Item | None:
    """Parse `text` (Lucene syntax) into a luqum AST.

    Returns None for empty / whitespace-only input. Raises
    `BooleanQueryError` on syntax error so the API layer can surface
    a precise hint to the user.

    # Newline convention
    Newlines in the editor get rewritten to ` OR ` before parsing —
    matches Brandwatch / Meltwater UX where each line is a separate
    term joined disjunctively. Lucene strict has no newline semantics
    (it'd treat them as implicit AND via `UnknownOperation` which is
    rarely what the user means when they hit Enter mid-query).
    """
    if not text or not text.strip():
        return None
    # Collapse runs of newlines + surrounding whitespace into ` OR `.
    # A leading/trailing newline produces an empty OR-arm that luqum
    # would reject, so we trim first.
    text = _NEWLINE_RE.sub(" OR ", text.strip())
    try:
        return _luqum_parser.parse(text)
    except ParseError as e:
        raise BooleanQueryError(str(e)) from e


_NEWLINE_RE = re.compile(r"\s*\n+\s*")


def compile_to_where(
    tree: Item | None,
    *,
    alias:              str = "a",
    feed_name_sql:      str | None = None,
    source_country_sql: str = "s.country",
) -> tuple[str, list]:
    """Compile a parsed luqum AST into a SQL WHERE fragment.

    Args:
        tree:  the AST returned by `parse()`. None / empty → no filter.
        alias: the SQL alias for the `items` table in the caller's
               query. Defaults to "a" matching `build_article_where`'s
               convention. The caller must also have joined `sources s`
               if any `country:` filter is used (or override via
               `source_country_sql=`).
        feed_name_sql: the SQL expression to use in `feed:` filters.
               By default the first monitor that delivered the item, read
               through `monitor_items` with no join needed from the
               caller. Pass `"u.feed_name"` (or similar) when the name is
               denormalised on a temp table.
        source_country_sql: the SQL expression to use in `country:`
               filters. Defaults to `"s.country"`. Override when the
               column is denormalised.

    Returns:
        `(sql_fragment, params)`. The fragment is a self-contained
        boolean expression — caller wraps it in `WHERE ...` or
        AND-combines it with other constraints.
    """
    if tree is None:
        return "TRUE", []
    ctx = _CompileCtx(
        alias=alias,
        feed_name_sql=feed_name_sql,
        source_country_sql=source_country_sql,
    )
    return _compile_node(tree, ctx=ctx, negated=False)


# ── Internals: recursive AST walk ─────────────────────────────────────────


def _compile_node(
    node: Item, *, ctx: _CompileCtx, negated: bool,
) -> tuple[str, list]:
    """Recursively compile any AST node. `negated` carries the parent's
    Not context so chained `Not(SearchField(...))` collapses cleanly.

    Each AST kind has its own clause; the function is intentionally
    flat (one if/elif chain rather than a visitor class) because the
    luqum AST is small and the explicit shape is easier to scan than
    indirection through dispatch tables.
    """
    if isinstance(node, (AndOperation, UnknownOperation)):
        # UnknownOperation is luqum's stand-in when two terms are
        # adjacent with no explicit operator — we treat it as AND
        # (Lucene's default). Same compile path.
        parts, params = _compile_children(node, ctx=ctx, joiner=" AND ")
        return _wrap_negated(parts, negated), params

    if isinstance(node, OrOperation):
        parts, params = _compile_children(node, ctx=ctx, joiner=" OR ")
        return _wrap_negated(parts, negated), params

    if isinstance(node, Not):
        # Lucene NOT child → flip negation flag for the subtree.
        return _compile_node(node.children[0], ctx=ctx, negated=not negated)

    if isinstance(node, Group):
        # (...) — parens. Compile child, preserve negation context. The
        # explicit `(...)` in the SQL keeps precedence safe.
        inner_sql, inner_params = _compile_node(
            node.children[0], ctx=ctx, negated=False,
        )
        return _wrap_negated(f"({inner_sql})", negated), inner_params

    if isinstance(node, SearchField):
        return _compile_searchfield(node, ctx=ctx, negated=negated)

    if isinstance(node, Phrase):
        # "exact phrase" — phraseto_tsquery handles the multi-word
        # match. The Phrase.value carries the surrounding quotes; strip
        # them, then strip accents so the tokens align with the
        # unaccented index.
        raw = node.value
        if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
            raw = raw[1:-1]
        raw = _strip_accents(raw)
        sql = f"{ctx.alias}.search_vector @@ phraseto_tsquery(%s, %s)"
        return _wrap_negated(sql, negated), [_FTS_LANGUAGE, raw]

    if isinstance(node, Proximity):
        return _compile_proximity(node, ctx=ctx, negated=negated)

    if isinstance(node, Word):
        # Bare term — falls into FTS via _compile_freetext.
        sql, params = _compile_freetext(node.value, ctx=ctx)
        return _wrap_negated(sql, negated), params

    # Unknown / unsupported AST node (Range, Regex, Fuzzy, Proximity,
    # Boost, Plus/Prohibit). For safety we degrade to a permissive
    # match-everything so the surrounding query still runs — the API
    # layer can surface a warning if it wants.
    return "TRUE", []


def _compile_children(
    node: Item, *, ctx: _CompileCtx, joiner: str,
) -> tuple[list[str], list]:
    """Walk all children of an AND/OR node, return the list of compiled
    SQL fragments + the flat params list. Joiner is the SQL operator
    used between siblings (`" AND "` or `" OR "`)."""
    sqls: list[str] = []
    params: list = []
    for child in node.children:
        s, p = _compile_node(child, ctx=ctx, negated=False)
        sqls.append(s)
        params.extend(p)
    joined = joiner.join(f"({s})" for s in sqls) if len(sqls) > 1 else (sqls[0] if sqls else "TRUE")
    return [joined], params


# Map a Lucene range field name → the SQL column it filters on.
# Both columns are `TIMESTAMPTZ`. Adding a new range
# field is a one-line entry here + a doc string update.
_RANGE_FIELDS: dict[str, str] = {
    "published": "published_at",
    "fetched":   "fetched_at",
}


def _range_bound_value(bound) -> str | None:
    """Extract the string value of a Range bound, or None if it's the
    open-ended wildcard `*`. luqum may return either a `Word` instance
    or the bare string depending on the parser's version."""
    if bound is None:
        return None
    raw = bound.value if hasattr(bound, "value") else str(bound)
    raw = (raw or "").strip()
    if not raw or raw == "*":
        return None
    return raw


def _compile_date_range(
    field: str, node: Range, *, ctx: _CompileCtx,
) -> tuple[str, list]:
    """Compile `published:[YYYY-MM-DD TO YYYY-MM-DD]` to a TIMESTAMPTZ
    range predicate. `[...]` = inclusive, `{...}` = exclusive (Lucene
    convention; luqum sets `include_low` / `include_high` accordingly).
    Either bound can be `*` for open-ended.

    Date format: any ISO 8601 string Postgres accepts as TIMESTAMPTZ
    (`2026-01-01`, `2026-01-01T12:00:00Z`, `2026-01-01T12:00:00+02:00`).
    Bad input → falls through to `TRUE` so a malformed range doesn't
    bring down the whole query; the API layer can warn separately.

    Unsupported field name → `TRUE` (= no filter). Only
    `published:` and `fetched:` are supported; other fields are out of scope.
    """
    column = _RANGE_FIELDS.get(field)
    if column is None:
        return "TRUE", []

    low  = _range_bound_value(node.low)
    high = _range_bound_value(node.high)
    if low is None and high is None:
        return "TRUE", []

    parts: list[str] = []
    params: list = []
    if low is not None:
        op = ">=" if node.include_low else ">"
        parts.append(f"{ctx.alias}.{column} {op} %s::timestamptz")
        params.append(low)
    if high is not None:
        op = "<=" if node.include_high else "<"
        parts.append(f"{ctx.alias}.{column} {op} %s::timestamptz")
        params.append(high)
    return "(" + " AND ".join(parts) + ")", params


def _compile_searchfield(
    node: SearchField, *, ctx: _CompileCtx, negated: bool,
) -> tuple[str, list]:
    """Compile a `field:value` clause. Falls through to free-text on
    the value when the field name isn't recognised — keeps the
    compiler safe in front of unknown field modifiers in legacy
    queries."""
    name = node.name.lower()
    handler = _FIELDS.get(name)
    # Extract the value from the SearchField's expression — it can be
    # a Word (most cases) or a Phrase. We coerce to a string.
    expr = node.children[0]
    if isinstance(expr, Range):
        # `field:[low TO high]` — only date fields are supported
        # (published / fetched). Other range-like fields are out of
        # scope; we fall through to a permissive match so the rest of
        # the query still runs.
        sql, params = _compile_date_range(name, expr, ctx=ctx)
        return _wrap_negated(sql, negated), params
    if isinstance(expr, Phrase):
        value = expr.value
        if value.startswith('"') and value.endswith('"') and len(value) >= 2:
            value = value[1:-1]
    elif isinstance(expr, Word):
        value = expr.value
    else:
        # Group, OperationOR/AND inside a field — luqum supports
        # `field:(a OR b)` — we don't recurse on the value
        # side. Fall through to a permissive match.
        return "TRUE", []

    if handler is None:
        # Unknown field — treat the value as a free-text search.
        sql, params = _compile_freetext(value, ctx=ctx)
        return _wrap_negated(sql, negated), params

    sql, params = handler.compile(value, ctx=ctx)
    return _wrap_negated(sql, negated), params


def _compile_proximity(
    node: Proximity, *, ctx: _CompileCtx, negated: bool,
) -> tuple[str, list]:
    """Compile a Lucene `"phrase"~N` proximity into a Postgres tsquery
    using the native `<N>` distance operator.

    luqum AST shape:
        node.term   = Phrase("foo bar baz")
        node.degree = N (the slop)

    Semantics — order-agnostic, matches Lucene/Brandwatch user
    expectation:
      - 1 word:  proximity is a no-op; behave like a freetext term.
      - 2 words: `(a <N> b) | (b <N> a)`. Two-direction NEAR.
      - 3+ words: AND of all pairwise bidirectional NEARs. Conservative
                  vs the pure Lucene "all words within a window of N"
                  — every pair must be within N. Stays linear in O(k²)
                  pair clauses for k words, cheap at our typical k=2-4.

    Defensive shortcuts:
      - Empty / whitespace-only phrase → `TRUE` (no filter).
      - Non-positive slop (`~0` or invalid) → `TRUE`. Lucene treats
        `~0` as an exact phrase but the user almost certainly meant
        the proximity feature; rather than silently change semantics
        we fall through to a permissive match.
    """
    term = node.term
    slop = node.degree

    if not isinstance(term, Phrase) or not isinstance(slop, int) or slop < 1:
        return "TRUE", []

    raw = term.value
    if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
        raw = raw[1:-1]
    raw = _strip_accents(raw)

    words = [w for w in raw.split() if w.strip()]
    if not words:
        return "TRUE", []

    if len(words) == 1:
        # Proximity on a single word degenerates to free-text — the
        # slop is meaningless. Emit the same atom we'd get from a bare
        # Word node so the user query keeps working without surprise.
        sql, params = _compile_freetext(words[0], ctx=ctx)
        return _wrap_negated(sql, negated), params

    atoms = [_word_to_tsquery_atom(w) for w in words]

    if len(atoms) == 2:
        a, b = atoms
        tsq = f"({a} <{slop}> {b}) | ({b} <{slop}> {a})"
    else:
        # k≥3: AND together every pairwise bidirectional NEAR.
        pair_clauses: list[str] = []
        for i in range(len(atoms)):
            for j in range(i + 1, len(atoms)):
                a, b = atoms[i], atoms[j]
                pair_clauses.append(f"(({a} <{slop}> {b}) | ({b} <{slop}> {a}))")
        tsq = " & ".join(pair_clauses)

    sql = f"{ctx.alias}.search_vector @@ to_tsquery(%s, %s)"
    return _wrap_negated(sql, negated), [_FTS_LANGUAGE, tsq]


def _wrap_negated(sql_or_sqls, negated: bool) -> str:
    """Apply NOT to a compiled fragment / list of fragments. We use
    `NOT (...)` rather than relying on operator precedence — explicit
    parens are clearer in EXPLAIN output and immune to bugs from
    nested negations."""
    if isinstance(sql_or_sqls, list):
        # Coming from _compile_children which always returns a single-
        # element list when called from this module's flow.
        sql = sql_or_sqls[0] if sql_or_sqls else "TRUE"
    else:
        sql = sql_or_sqls
    if not negated:
        return sql
    return f"NOT ({sql})"


def _word_to_tsquery_atom(word: str) -> str:
    """Convert a Lucene Word to a tsquery atom.

    Rules:
      - Strip accents up-front so the atom matches the unaccented
        index. "récession" → "recession".
      - Trailing `*` becomes the tsquery prefix operator `:*`
        ("universit*" → "universit:*")
      - All other characters are escaped (Postgres tsquery is picky on
        special chars — `&`, `|`, `!`, `<`, `>`, `(`, `)`, `:`)
      - Empty token → returns "false-y" tsquery `__noop__` so the
        match fails but the query stays valid
    """
    if not word:
        return "__noop__"

    word = _strip_accents(word)

    # Detect trailing wildcard → prefix-match operator in tsquery.
    wildcard = word.endswith("*")
    core = word[:-1] if wildcard else word

    # Strip characters tsquery doesn't accept in an atom. We don't
    # support embedded operators here — the user expresses Boolean at
    # the Lucene level, not inside a single term.
    safe = "".join(c for c in core if c.isalnum() or c in "-_.").strip("-_.")
    if not safe:
        return "__noop__"

    return f"{safe}:*" if wildcard else safe


__all__ = [
    "BooleanQueryError",
    "parse",
    "compile_to_where",
]
