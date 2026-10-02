r"""
search_entities — resolve a name into Wikidata Q-id candidates.

The agent thinks in human names ("Macron", "Renault", "Banque centrale
européenne") but the Boolean DSL filters by Q-id (`entity:Q3052772`).
This tool bridges the gap: pass a name, get back a ranked list of
candidate entities with enough metadata for the agent to pick.

When several candidates come back (e.g. "Macron" → Emmanuel + Brigitte +
others), the agent shows them to the user or picks the most likely
based on context, then drops the Q-id into a `boolean_query`.

Match strategy is keep-it-simple:
  1. Exact case-insensitive match on `canonical_label`.
  2. ILIKE substring on `canonical_label`.
  3. **Whole-word** match on `aliases` (any element of the array).
  4. **Whole-word** match on `label_translations` values across
     languages.

Tiers 3 and 4 use Postgres word-boundary regex (`\m…\M`) rather than
substring ILIKE because substring matching produced bad false
positives: searching for "La Liga" used to surface "Order of the
Garter" because some alias happened to embed those characters mid-
token. Word-boundary matching makes the search precision-first.

Results are merged, deduped on entity id, and ordered by:
  - exact match first (tier 1 above)
  - rows with corpus presence (`n_articles_in_corpus > 0`) ahead of
    "orphan" rows within the same tier — an alias hit that's never
    been observed in any article is most likely a name collision
  - then by `n_articles_in_corpus` desc.

Only the cached `entities` table is searched (entities Veilla has
already seen at ingest). Brand-new entities are not looked up on
Wikidata here: when nothing comes back, the agent should ask the user.
"""
import re

from src.db import get_connection

# Same caps as the other read tools — keeps the response light enough
# for the LLM's context window without forcing it to paginate just to
# disambiguate "Macron".
DEFAULT_LIMIT = 5
MAX_LIMIT     = 20


# Kinds the normalizer's extractor produces (mirrors the CHECK
# constraint on `entities.kind`). Used to validate optional `kind`
# filter without round-tripping to the DB.
VALID_KINDS = {"person", "org", "location", "event", "market", "product"}


def search_entities(
    name:  str,
    kind:  str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> dict:
    """Find candidate Wikidata entities matching a human-readable name.

    Use this when the agent wants to filter by `entity:Q…` in a
    `boolean_query` but only knows the human-friendly name. Returns
    ranked candidates with enough context (label, description, kind,
    country, article count in the corpus) for the agent to pick the
    right Q-id — or to show the user a disambiguation prompt when
    several plausible matches come back.

    Args:
        name: the human-readable name to look up — single string, no
            wildcards. Case-insensitive. Examples:
              "Emmanuel Macron" / "Macron" / "Renault" / "OPEP" / "BCE".
            Accent-sensitive on purpose (the DB stores labels with
            their original diacritics).
        kind: optional filter by entity kind. One of: 'person', 'org',
            'location', 'event', 'market', 'product'. Disambiguates
            cases like "Apple" the company vs "apple" the location of
            an event.
        limit: max candidates returned. Default 5, max 20. The agent
            asks for more only when the user explicitly wants the
            full picker.

    Returns:
        {
          "name":         <echoed query>,
          "kind":         <echoed filter, or null>,
          "n_candidates": <int — len(candidates)>,
          "candidates": [
            {
              "qid":                  "Q3052772",
              "kind":                 "person",
              "label":                "Emmanuel Macron",
              "description":          "President of France since 2017",
              "country":              "FR",
              "image_url":            "https://commons.…",
              "n_articles_in_corpus": 1342,
              "match_tier":           "exact_label" |
                                       "label_substring" |
                                       "alias" |
                                       "translation"
            },
            ...
          ]
        }

        Empty `candidates` list is normal — means Veilla hasn't ingested
        any article mentioning the name yet. The agent should tell the
        user, NOT silently fall back to a free-text search (the
        agent can choose to do so explicitly afterwards).

    Raises:
        ValueError on empty `name`, invalid `kind`, or out-of-range
        `limit`.
    """
    # ─── Args validation ───────────────────────────────────────────────
    if not isinstance(name, str) or not name.strip():
        raise ValueError("name must be a non-empty string")
    name_norm = name.strip()

    if kind is not None and kind not in VALID_KINDS:
        raise ValueError(
            f"kind must be one of {sorted(VALID_KINDS)} or None, "
            f"got {kind!r}"
        )

    if not isinstance(limit, int) or limit <= 0:
        raise ValueError(f"limit must be a positive integer, got {limit!r}")
    if limit > MAX_LIMIT:
        raise ValueError(f"limit capped at {MAX_LIMIT}, got {limit}")

    # ─── Build the matching tiers + run one query each ─────────────────
    # We could fold this into a single SQL with a CASE-based ranking
    # column, but separate queries are easier to read and let us short-
    # circuit once we have `limit` candidates (most queries hit tier 1
    # alone and stop). Each tier returns the same shape — `match_tier`
    # tags the source so downstream callers can see why a row came
    # back, and we merge in priority order.
    #
    # Deduplication across tiers is handled in Python via `seen_ids`
    # (see the loop below). We deliberately don't add `NOT ILIKE`
    # filters in the SQL of later tiers because the Python dedup is
    # already correct and the extra SQL predicates are easy to forget
    # to update when the matching logic evolves.
    kind_filter_sql    = " AND e.kind = %s" if kind else ""
    kind_filter_params = [kind] if kind else []

    # Postgres regex `\m` / `\M` mark word boundaries. We escape the
    # user-provided name for regex safety (a stray `.` or `(` would
    # otherwise match anything / break the regex).
    name_word_pattern = r"\m" + re.escape(name_norm) + r"\M"

    queries = [
        # Tier 1 — exact match (case-insensitive).
        (
            "exact_label",
            f"""
            SELECT e.id, e.wikidata_id, e.kind, e.canonical_label,
                   e.description, e.country, e.image_url
              FROM entities e
             WHERE e.status = 'active'
               AND LOWER(e.canonical_label) = LOWER(%s)
               {kind_filter_sql}
            """,
            [name_norm, *kind_filter_params],
        ),
        # Tier 2 — substring on canonical_label. We keep ILIKE substring
        # here (not word-boundary) because the user often searches a
        # prefix ("Macron" matching "Emmanuel Macron") and that's a
        # legitimate signal on the canonical label specifically.
        (
            "label_substring",
            f"""
            SELECT e.id, e.wikidata_id, e.kind, e.canonical_label,
                   e.description, e.country, e.image_url
              FROM entities e
             WHERE e.status = 'active'
               AND e.canonical_label ILIKE %s
               {kind_filter_sql}
            """,
            [f"%{name_norm}%", *kind_filter_params],
        ),
        # Tier 3 — whole-word match in aliases array (any language).
        # We use Postgres' `~*` regex with `\m…\M` boundaries instead
        # of the previous ILIKE substring — substring matching surfaced
        # bad false positives where the query string appeared mid-token
        # in an unrelated alias (e.g. "La Liga" pulling in "Order of
        # the Garter" because of stray alias content).
        (
            "alias",
            f"""
            SELECT e.id, e.wikidata_id, e.kind, e.canonical_label,
                   e.description, e.country, e.image_url
              FROM entities e
             WHERE e.status = 'active'
               AND EXISTS (
                   SELECT 1 FROM unnest(e.aliases) AS al
                    WHERE al ~* %s
               )
               {kind_filter_sql}
            """,
            [name_word_pattern, *kind_filter_params],
        ),
        # Tier 4 — whole-word match in label_translations values across
        # languages. Same boundary rule as tier 3, same rationale.
        # Stays out of any index but the entities table is small enough
        # (~tens of thousands of rows) that a Seq Scan with regex match
        # is fine; we only hit this tier when tiers 1-3 underperform.
        (
            "translation",
            f"""
            SELECT e.id, e.wikidata_id, e.kind, e.canonical_label,
                   e.description, e.country, e.image_url
              FROM entities e
             WHERE e.status = 'active'
               AND EXISTS (
                   SELECT 1
                     FROM jsonb_each_text(e.label_translations)
                    WHERE value ~* %s
               )
               {kind_filter_sql}
            """,
            [name_word_pattern, *kind_filter_params],
        ),
    ]

    seen_ids: set[int] = set()
    rows: list[tuple] = []  # (match_tier, db_row)

    conn = get_connection()
    try:
        cur = conn.cursor()
        for tier, sql, params in queries:
            if len(rows) >= limit:
                break
            # Order each tier by article count (we resolve that after
            # collecting rows — needs one more query, see below) — for
            # now just trust the DB ordering.
            cur.execute(sql + " ORDER BY e.canonical_label LIMIT %s",
                        params + [limit - len(rows)])
            for r in cur.fetchall():
                ent_id = r[0]
                if ent_id in seen_ids:
                    continue
                seen_ids.add(ent_id)
                rows.append((tier, r))

        # Resolve `n_articles_in_corpus` for the gathered candidates in
        # one batch query — avoids N+1 against item_entities.
        n_articles_by_id: dict[int, int] = {}
        if rows:
            ids_list = [r[1][0] for r in rows]
            cur.execute(
                """
                SELECT entity_id, COUNT(DISTINCT item_id)
                  FROM item_entities
                 WHERE entity_id = ANY(%s)
                 GROUP BY entity_id
                """,
                (ids_list,),
            )
            for ent_id, n in cur.fetchall():
                n_articles_by_id[ent_id] = int(n)
    finally:
        conn.close()

    # ─── Build the candidates payload ──────────────────────────────────
    candidates = []
    for tier, r in rows:
        ent_id, qid, ent_kind, label, description, country, image_url = r
        candidates.append({
            "qid":                  qid,
            "kind":                 ent_kind,
            "label":                label,
            "description":          description,
            "country":              country,
            "image_url":            image_url,
            "n_articles_in_corpus": n_articles_by_id.get(ent_id, 0),
            "match_tier":           tier,
        })

    # Final ordering: tier first, then push orphans (rows the corpus
    # has never seen) to the bottom of their tier, then by corpus
    # presence desc. The orphan demotion is what prevents stale or
    # collision entries from outranking entities the agent actually
    # cares about — an alias hit on a row with 0 articles is almost
    # always a name collision, not the right entity.
    _tier_rank = {
        "exact_label":     0,
        "label_substring": 1,
        "alias":           2,
        "translation":     3,
    }
    candidates.sort(
        key=lambda c: (
            _tier_rank.get(c["match_tier"], 99),
            1 if c["n_articles_in_corpus"] == 0 else 0,
            -c["n_articles_in_corpus"],
        ),
    )

    return {
        "name":         name_norm,
        "kind":         kind,
        "n_candidates": len(candidates),
        "candidates":   candidates,
    }
