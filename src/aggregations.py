"""
Server-side sidebar aggregations.

Mirrors `webapp/lib/aggregate.ts` but in Python over the already-rendered
stories+singletons that load_watch produces. Returns a flat dict that
the frontend localizes (countryLabel, regionLabel, langLabel) at render
time — we don't ship locale-aware strings from here.

# Why compute server-side

Computed client-side, `aggregate(data.stories, data.singletons)` would run
twice per /watch render — once for totals, once for the unread-filtered
universe (= the `aggsUnread` path). At 5 users that's fine, at 250
users with 800 stories per /watch each, the JS loop becomes noticeable
and — more importantly — pagination is impossible without it: a
paginated /watch payload doesn't contain the full universe, so the
client can't compute correct sidebar counts.

# Counting unit (= matches frontend)

Each *item* (story OR singleton) is tallied ONCE per distinct dimension
value it touches. A cluster of 10 articles all from Reuters counts as
ONE Reuters mention, not ten. Entities mentioned by multiple articles
in the same cluster are deduplicated before bumping.

# Unread tally

For each dim value, we emit BOTH `count` (= total items) and `unread`
(= items where user_state.is_unread OR has_update, NOT ignored). The
frontend Sidebar reads both directly — no second `aggsUnread`
aggregation pass is needed.
"""


def _is_item_unread(item: dict) -> bool:
    """Apply the same predicate the frontend uses to decide if an item
    counts as 'unread' for the badge. Returns False if no user_state is
    attached (= non-owner viewer) — those callers don't render unread
    badges at all so the value is immaterial."""
    state = item.get("user_state")
    if not state:
        return False
    if state.get("ignored"):
        return False
    return bool(state.get("is_unread") or state.get("has_update"))


def _is_item_ignored(item: dict) -> bool:
    state = item.get("user_state") or {}
    return bool(state.get("ignored"))


def compute_aggregations(
    stories: list[dict],
    singletons: list[dict],
) -> dict:
    """
    Build the sidebar aggregations payload.

    Stories and singletons must carry the per-article fields the
    frontend's `aggregate()` reads: `entities` (parsed dict),
    `category` (list), `countries` (list), `feed_name`, `source`,
    `source_country`, `lang`. The story dict optionally carries
    `user_state`.

    Returns a dict shaped for the frontend adapter — see
    `webapp/lib/server-aggs.ts`.
    """
    # Per-dimension accumulators. Each value is a slot dict tracking
    # count + unread + (for feeds) the canonical source/country metadata.
    feeds:           dict[str, dict] = {}
    langs:           dict[str, dict] = {}
    src_countries:   dict[str, dict] = {}   # keyed by ISO code (UPPER)
    subj_countries:  dict[str, dict] = {}   # keyed by ISO code (UPPER)
    categories:      dict[str, dict] = {}
    persons:         dict[str, dict] = {}   # keyed by entity_key (lower)
    orgs:            dict[str, dict] = {}
    locations:       dict[str, dict] = {}
    events:          dict[str, dict] = {}
    markets:         dict[str, dict] = {}
    products:        dict[str, dict] = {}

    n_articles = 0

    def _bump(target: dict, key: str, is_unread: bool, label: str | None = None) -> None:
        slot = target.setdefault(key, {"count": 0, "unread": 0})
        slot["count"] += 1
        if is_unread:
            slot["unread"] += 1
        if label is not None:
            existing = slot.get("label")
            if existing is None:
                slot["label"] = label
            else:
                # Prefer a casing that has at least one uppercase letter —
                # same heuristic as the frontend's dedupeByCaseFold.
                if any(c.isupper() for c in label) and not any(c.isupper() for c in existing):
                    slot["label"] = label

    def _tally_item(item: dict, articles: list[dict]) -> None:
        nonlocal n_articles

        # Skip ignored items entirely — they shouldn't bump any dimension
        # (matches the frontend tally which short-circuits on `state.ignored`).
        if _is_item_ignored(item):
            return

        if not articles:
            return

        is_unread = _is_item_unread(item)

        # Dedup per-item: a story mentioning Macron across 5 sources
        # counts once for the "Macron" dimension, not five times.
        seen_feeds:    dict[str, dict] = {}
        seen_langs:    set[str] = set()
        seen_src:      set[str] = set()
        seen_subj:     set[str] = set()
        seen_cats:     set[str] = set()
        # Entities are now keyed by `entity_id` (BIGINT from `entities`
        # table) instead of a case-folded surface form. We track the
        # full metadata bag once per kind/entity_id so the emit step
        # can serve canonical name + country + image_url + description
        # to the SPA without a follow-up DB lookup.
        seen_persons:  dict[int, dict] = {}    # entity_id -> meta
        seen_orgs:     dict[int, dict] = {}
        seen_locs:     dict[int, dict] = {}
        seen_events:   dict[int, dict] = {}
        seen_markets:  dict[int, dict] = {}
        seen_products: dict[int, dict] = {}

        kind_to_bucket = {
            "person":   seen_persons,
            "org":      seen_orgs,
            "location": seen_locs,
            "event":    seen_events,
            "market":   seen_markets,
            "product":  seen_products,
        }

        for a in articles:
            n_articles += 1
            fn = a.get("feed_name") or a.get("source")
            if fn and fn not in seen_feeds:
                seen_feeds[fn] = a
            lang = a.get("lang")
            if lang:
                seen_langs.add(lang)
            sc = a.get("source_country")
            if sc:
                seen_src.add(sc.upper())
            for c in (a.get("countries") or []):
                if c:
                    seen_subj.add(c.upper())
            for c in (a.get("category") or []):
                if c:
                    seen_cats.add(c)
            # Entities are a FLAT LIST of dicts:
            #   {entity_id, qid, name, kind, country, image_url,
            #    description, salience, surface_form}
            # See loaders.watch.load_visible_articles for the shape.
            ents = a.get("entities") or []
            if isinstance(ents, list):
                for ent in ents:
                    if not isinstance(ent, dict):
                        continue
                    eid  = ent.get("entity_id")
                    kind = ent.get("kind")
                    if not isinstance(eid, int) or kind not in kind_to_bucket:
                        continue
                    bucket = kind_to_bucket[kind]
                    if eid not in bucket:
                        # First time we see this entity in this item —
                        # capture the metadata. Same entity in another
                        # article of the same story is silently skipped
                        # (per-item dedup).
                        bucket[eid] = {
                            "qid":          ent.get("qid"),
                            "name":         ent.get("name") or "",
                            "country":      ent.get("country"),
                            "image_url":    ent.get("image_url"),
                            "description":  ent.get("description"),
                        }

        # Bump global aggregations once per item per distinct value seen.
        for fn, sample in seen_feeds.items():
            slot = feeds.setdefault(fn, {
                "count":   0,
                "unread":  0,
                "source":  sample.get("source"),
                "country": sample.get("source_country"),
            })
            slot["count"] += 1
            if is_unread:
                slot["unread"] += 1
        for lang in seen_langs:
            _bump(langs, lang, is_unread)
        for code in seen_src:
            _bump(src_countries, code, is_unread)
        for code in seen_subj:
            _bump(subj_countries, code, is_unread)
        for cat in seen_cats:
            _bump(categories, cat, is_unread)

        # Entity bumps: int-keyed, metadata-rich.
        def _bump_entity(target: dict, eid: int, meta: dict, is_unread: bool) -> None:
            slot = target.setdefault(eid, {"count": 0, "unread": 0, "meta": meta})
            slot["count"] += 1
            if is_unread:
                slot["unread"] += 1

        for eid, meta in seen_persons.items():
            _bump_entity(persons, eid, meta, is_unread)
        for eid, meta in seen_orgs.items():
            _bump_entity(orgs, eid, meta, is_unread)
        for eid, meta in seen_locs.items():
            _bump_entity(locations, eid, meta, is_unread)
        for eid, meta in seen_events.items():
            _bump_entity(events, eid, meta, is_unread)
        for eid, meta in seen_markets.items():
            _bump_entity(markets, eid, meta, is_unread)
        for eid, meta in seen_products.items():
            _bump_entity(products, eid, meta, is_unread)

    for s in stories:
        _tally_item(s, s.get("articles") or [])
    for a in singletons:
        _tally_item(a, [a])

    # Emit sorted lists. Tie-break alphabetical on label/code so equal-
    # count rows have a deterministic order (frontend's `aggregate.ts`
    # also tie-breaks alphabetically — we mirror that).
    def _emit_keyed(slot_map: dict, key_field: str) -> list[dict]:
        out = []
        for k, slot in slot_map.items():
            row = {key_field: k, "count": slot["count"], "unread": slot["unread"]}
            for k2, v2 in slot.items():
                if k2 not in {"count", "unread"} and k2 not in row:
                    row[k2] = v2
            out.append(row)
        out.sort(key=lambda x: (-x["count"], x[key_field]))
        return out

    def _emit_entity(slot_map: dict, kind: str) -> list[dict]:
        """Emit canonical entity rows with full metadata. Each row
        carries everything the SPA needs to render the sidebar entry
        (avatar / flag / name / count) without a follow-up round-trip."""
        out = []
        for eid, slot in slot_map.items():
            meta = slot.get("meta") or {}
            out.append({
                "entity_id":    int(eid),
                "qid":          meta.get("qid"),
                "name":         meta.get("name") or "",
                "kind":         kind,
                "country":      meta.get("country"),
                "image_url":    meta.get("image_url"),
                "description":  meta.get("description"),
                "count":        slot["count"],
                "unread":       slot["unread"],
            })
        out.sort(key=lambda x: (-x["count"], x["name"]))
        return out

    return {
        "feeds":             _emit_keyed(feeds, key_field="name"),
        "langs":             _emit_keyed(langs, key_field="code"),
        "origin_countries":  _emit_keyed(src_countries, key_field="code"),
        "subject_countries": _emit_keyed(subj_countries, key_field="code"),
        "categories":        _emit_keyed(categories, key_field="name"),
        "entities": {
            "persons":   _emit_entity(persons,   "person"),
            "orgs":      _emit_entity(orgs,      "org"),
            "locations": _emit_entity(locations, "location"),
            "events":    _emit_entity(events,    "event"),
            "markets":   _emit_entity(markets,   "market"),
            "products":  _emit_entity(products,  "product"),
        },
        "total": {
            "stories":    len(stories),
            "singletons": len(singletons),
            "articles":   n_articles,
            "feeds":      len(feeds),
        },
    }
