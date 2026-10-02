"""
Single source of truth for Veilla's country/region taxonomy.

Three concepts coexist intentionally:

  1. **Regional codes** (3-letter): the broad-zone codes the LLM normalizer
     is allowed to emit in `items.countries[]`. 3-letter on purpose —
     guaranteed never to collide with ISO 3166-1 alpha-2 (the old `EU`,
     `ME`, `AS`, `AF` codes collided with Montenegro/American Samoa/
     Afghanistan and caused silent display bugs).

  2. **`REGION_MEMBERS`** (regional code → list of country codes): the
     canonical mapping. Stored region-first because it reads as a human
     ontology ("Europe is composed of …"). The reverse `COUNTRY_TO_BROAD`
     is derived at import time for O(1) lookups.

  3. **`COUNTRY_TO_REGION`** (country/regional code → UI bucket name): a
     separate concept used only for SIDEBAR GROUPING. The buckets
     (Europe / Americas / Asia / Africa / MiddleEast / Oceania / Global /
     Other) are display-only and not equivalent to regional codes
     (e.g. "Americas" isn't a single regional code — LAT is Latin
     America only; US/CA don't map to any broad code).

This module is the SOLE place where the taxonomy lives. The TypeScript
counterpart (`webapp/lib/taxonomy.generated.ts`) is auto-generated from
this file by `scripts/sync_taxonomy.py`. **Do not edit the .ts file by
hand.** When adding a country / region / label, edit here and re-run
the sync script.
"""
from __future__ import annotations

# ── Regional codes ─────────────────────────────────────────────────────
# The 6 broad-zone codes the normalizer LLM can emit.
REGIONAL_CODES: list[str] = ["EUR", "MID", "ASI", "AFR", "LAT", "OCE"]

# Localized labels for the regional codes. Used by the frontend chip
# rendering — without this override `Intl.DisplayNames` would render the
# raw code (it doesn't know our pseudo-codes).
REGIONAL_LABELS: dict[str, dict[str, str]] = {
    "EUR": {"fr": "Union européenne", "en": "European Union"},
    "MID": {"fr": "Moyen-Orient",      "en": "Middle East"},
    "ASI": {"fr": "Asie",              "en": "Asia"},
    "AFR": {"fr": "Afrique",           "en": "Africa"},
    "LAT": {"fr": "Amérique latine",   "en": "Latin America"},
    "OCE": {"fr": "Océanie",           "en": "Oceania"},
}


# ── Region members (canonical, region-first) ───────────────────────────
# Direction REGION → MEMBERS so the human reading the file sees the
# ontology naturally. COUNTRY_TO_BROAD is derived from this at import.
#
# Coverage: every UN member state + the highest-news-volume non-UN
# territories (HK, MO, TW, PS, XK, PR, AS). Editorial choices made for
# borderline countries — documented inline. Single-region-per-country
# (UN M.49 allows multi-region membership for Turkey/Russia/etc., but
# news matching needs ONE deterministic answer).
#
# Note: US, CA, GL have NO broad ancestor — the normalizer has no
# "North America" macro code (it would collide with NA = Namibia
# anyway). They stay as standalone country codes; UI bucket grouping
# is handled separately via COUNTRY_TO_REGION below.
REGION_MEMBERS: dict[str, list[str]] = {
    # Europe — EU27 + EFTA + UK + Western Balkans + Eastern Europe +
    # micro-states + Russia (Western media convention; geographically
    # transcontinental, but news contexts overwhelmingly treat it as
    # European for foreign-policy + war coverage).
    "EUR": [
        "AD", "AL", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ",
        "DE", "DK", "EE", "ES", "FI", "FR", "GB", "GR", "HR", "HU",
        "IE", "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME",
        "MK", "MT", "NL", "NO", "PL", "PT", "RO", "RS", "RU", "SE",
        "SI", "SK", "SM", "UA", "VA", "XK",
    ],
    # Asia — East Asia, Southeast Asia, South Asia, Central Asia,
    # Caucasus. Includes Afghanistan (Central/South Asia), Mongolia,
    # Timor-Leste. Excludes the Middle East cluster (separate region).
    # Hong Kong, Macao, Taiwan included as standalone codes.
    "ASI": [
        "AF", "AM", "AZ", "BD", "BN", "BT", "CN", "GE", "HK", "ID",
        "IN", "JP", "KG", "KH", "KP", "KR", "KZ", "LA", "LK", "MM",
        "MN", "MO", "MV", "MY", "NP", "PH", "PK", "SG", "TH", "TJ",
        "TL", "TM", "TW", "UZ", "VN",
    ],
    # Middle East — Arab states, Iran, Israel, Turkey (transcontinental
    # but news contexts treat it as Middle East), Palestine.
    "MID": [
        "AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS",
        "QA", "SA", "SY", "TR", "YE",
    ],
    # Africa — all 54 UN African states. Egypt stays in AFR (geographic
    # placement) although news coverage often overlaps with MID.
    "AFR": [
        "AO", "BF", "BI", "BJ", "BW", "CD", "CF", "CG", "CI", "CM",
        "CV", "DJ", "DZ", "EG", "ER", "ET", "GA", "GH", "GM", "GN",
        "GQ", "GW", "KE", "KM", "LR", "LS", "LY", "MA", "MG", "ML",
        "MR", "MU", "MW", "MZ", "NA", "NE", "NG", "RW", "SC", "SD",
        "SL", "SN", "SO", "SS", "ST", "SZ", "TD", "TG", "TN", "TZ",
        "UG", "ZA", "ZM", "ZW",
    ],
    # Latin America & Caribbean — South + Central America + Mexico +
    # major Caribbean states (Cuba, Haiti, DR, Jamaica, Trinidad +
    # PR territory).
    "LAT": [
        "AR", "BO", "BR", "BZ", "CL", "CO", "CR", "CU", "DO", "EC",
        "GT", "GY", "HN", "HT", "JM", "MX", "NI", "PA", "PE", "PR",
        "PY", "SV", "SR", "TT", "UY", "VE",
    ],
    # Oceania — Australia, NZ, Pacific island nations + American Samoa
    # (US territory in the Pacific).
    "OCE": [
        "AS", "AU", "FJ", "FM", "KI", "MH", "NR", "NZ", "PG", "PW",
        "SB", "TO", "TV", "VU", "WS",
    ],
}

# Derived: country code → regional code (O(1) lookup). Countries with no
# broad ancestor (US, CA) are simply absent from this map.
COUNTRY_TO_BROAD: dict[str, str] = {
    country: region
    for region, countries in REGION_MEMBERS.items()
    for country in countries
}


# ── Global code ────────────────────────────────────────────────────────
# Special placeholder for sources that have NO geographic home: global
# institutions like IMF, OECD, WTO. Replaces the old "INT" placeholder
# which conflated these with pan-regional publishers (Jeune Afrique
# was wrongly tagged "INT" instead of "AFR" — fixed in this migration).
GLOBAL_CODE: str = "GLB"

GLOBAL_LABELS: dict[str, str] = {"fr": "Mondial", "en": "Global"}


# ── UI bucket grouping (sidebar Pays section) ──────────────────────────
# Distinct from regional codes — used purely for visual grouping in
# dropdowns and sidebar. "Americas" intentionally collapses LAT + US/CA
# into a single bucket because the sidebar groups by continent, not by
# the LLM's broad-code taxonomy.
REGION_BUCKETS: list[str] = [
    "Europe", "Americas", "Asia", "Africa", "MiddleEast", "Oceania",
    "Global", "Other",
]

REGION_BUCKET_LABELS: dict[str, dict[str, str]] = {
    "en": {
        "Europe":     "Europe",
        "Americas":   "Americas",
        "Asia":       "Asia",
        "Africa":     "Africa",
        "MiddleEast": "Middle East",
        "Oceania":    "Oceania",
        "Global":     "Global",
        "Other":      "Other",
    },
    "fr": {
        "Europe":     "Europe",
        "Americas":   "Amériques",
        "Asia":       "Asie",
        "Africa":     "Afrique",
        "MiddleEast": "Moyen-Orient",
        "Oceania":    "Océanie",
        "Global":     "Mondial",
        "Other":      "Autre",
    },
}

# Country/regional code → UI bucket. Built from REGION_MEMBERS plus
# the explicit US/CA placement and the regional codes themselves.
COUNTRY_TO_REGION: dict[str, str] = {
    # EUR members → Europe
    **{c: "Europe"     for c in REGION_MEMBERS["EUR"]},
    # ASI members → Asia
    **{c: "Asia"       for c in REGION_MEMBERS["ASI"]},
    # MID members → MiddleEast
    **{c: "MiddleEast" for c in REGION_MEMBERS["MID"]},
    # AFR members → Africa
    **{c: "Africa"     for c in REGION_MEMBERS["AFR"]},
    # LAT members + US/CA → Americas
    **{c: "Americas"   for c in REGION_MEMBERS["LAT"]},
    "US": "Americas", "CA": "Americas",
    # OCE members → Oceania
    **{c: "Oceania"    for c in REGION_MEMBERS["OCE"]},
    # Regional codes themselves bucket into their matching region
    "EUR": "Europe",
    "ASI": "Asia",
    "MID": "MiddleEast",
    "AFR": "Africa",
    "LAT": "Americas",
    "OCE": "Oceania",
    # Global code → Global bucket
    GLOBAL_CODE: "Global",
}


# ── Curated dropdown list ──────────────────────────────────────────────
# Smaller than the full taxonomy — exhaustive ISO 3166 would drown the
# UI with 200+ rarely-used codes. Mirrors what the SPA shows in the
# preferences / view editor / filter dialog. Includes EUR so a single
# pick of "European Union" expands to all EU children at match time.
COUNTRY_CODES: list[str] = [
    # Europe + EUR bucket
    "FR", "GB", "DE", "IT", "ES", "PT", "NL", "BE", "CH", "AT",
    "SE", "NO", "DK", "FI", "IE", "PL", "CZ", "GR", "RO", "HU",
    "UA", "RS", "EUR",
    # Americas + LAT bucket (no broad code for the whole Americas)
    "US", "CA", "MX", "BR", "AR", "CL", "CO", "PE", "VE", "LAT",
    # Asia + ASI bucket
    "CN", "JP", "KR", "IN", "HK", "TW", "SG", "ID", "TH", "VN",
    "PH", "PK", "BD", "ASI",
    # Africa + AFR bucket
    "ZA", "NG", "KE", "EG", "MA", "GH", "SN", "ET", "DZ", "TN", "AFR",
    # Middle East + MID bucket
    "AE", "IL", "SA", "QA", "IR", "TR", "LB", "JO", "SY", "MID",
    # Oceania + OCE bucket
    "AU", "NZ", "OCE",
    # Global topics (IMF/WHO/COP-level worldwide scope)
    "GLB",
]


# ── Validation ─────────────────────────────────────────────────────────
# Set of every value legally storable in `sources.country` (catalog) and
# every element legally allowed in `items.countries[]`. Used by the
# catalog sync script and could be used at LLM output validation time.
VALID_COUNTRY_CODES: set[str] = (
    set(COUNTRY_TO_BROAD.keys())     # member countries
    | set(REGIONAL_CODES)             # broad-zone codes
    | {"US", "CA"}                    # countries with no broad ancestor
    | {GLOBAL_CODE}                   # global placeholder
)


def is_valid_country_code(code: str) -> bool:
    """True iff `code` is a legal value for sources.country or an element
    of items.countries[]. Use this in catalog sync to refuse invalid
    entries at boot time."""
    return code in VALID_COUNTRY_CODES


def assert_valid_country_code(code: str, context: str = "") -> str:
    """Raise ValueError with a helpful message if the code is invalid.
    `context` is appended to the error (e.g. the source domain that has
    a bad country tag)."""
    if not is_valid_country_code(code):
        suffix = f" (in {context})" if context else ""
        raise ValueError(
            f"Invalid country code {code!r}{suffix}. "
            f"Expected one of: 2-letter ISO country code, regional code "
            f"({', '.join(REGIONAL_CODES)}), or {GLOBAL_CODE!r} (global)."
        )
    return code


# ── Article categories ─────────────────────────────────────────────────
# 16-bucket newsroom taxonomy. The index (1-based) is what the LLM
# normalizer is asked to emit; the canonical English label is what we
# store in items.category. Add a new category → add it here, append
# only (changing existing indices would silently re-tag old articles).
CATEGORIES: list[str] = [
    "Domestic Politics",        # 1
    "Geopolitics & Conflicts",  # 2
    "Justice & Legal Affairs",  # 3
    "Crime & Public Safety",    # 4
    "Economy",                  # 5
    "Finance & Markets",        # 6
    "Business & Industry",      # 7
    "Energy & Climate",         # 8
    "Technology & AI",          # 9
    "Science",                  # 10
    "Health",                   # 11
    "Society & Labour",         # 12
    "Education",                # 13
    "Media & Culture",          # 14
    "Sport",                    # 15
    "Other",                    # 16
]
VALID_CATEGORY_INDICES: set[int] = set(range(1, len(CATEGORIES) + 1))
VALID_CATEGORY_NAMES: set[str]   = set(CATEGORIES)


# ── Article types ──────────────────────────────────────────────────────
# Format classification (news vs feature vs opinion etc.). Closed enum;
# the extractor drops anything outside this set. Stored as TEXT in
# items.article_type.
ARTICLE_TYPES: list[str] = [
    "news",          # standard factual news report, breaking news, brief
    "feature",       # in-depth analysis, investigation, explainer
    "opinion",       # editorial, column, op-ed, commentary
    "interview",     # Q&A, conversation
    "recap",         # roundup, digest, daily/weekly summary
    "multimedia",    # video, podcast, photo gallery (non-text)
    "institutional", # official press release, statistics, communiqué
]
VALID_ARTICLE_TYPES: set[str] = set(ARTICLE_TYPES)


# ── Entity types ───────────────────────────────────────────────────────
# Keys the extractor populates in items.entities. Order matters for
# UI rendering (frontend EntitiesBlock iterates this list). Adding a
# new type = backend extractor + frontend rendering must move together.
ENTITY_TYPES: list[str] = [
    "persons",    # public figures who are the subject of the article
    "orgs",       # companies, parties, institutions, central banks, NGOs
    "locations",  # cities, regions, rivers, mountains, landmarks (sub-country)
    "events",     # named scheduled events: summits, conferences, sport finals
    "markets",    # market instruments / indices: CAC 40, Brent crude, S&P 500
    "products",   # named products / models: ChatGPT, iPhone 16, F-35
]
VALID_ENTITY_TYPES: set[str] = set(ENTITY_TYPES)


# ── Languages ──────────────────────────────────────────────────────────
# ISO 639-1 codes we routinely encounter in feeds. Used only for shape
# validation (= the LLM emitted a real 2-letter code, not noise). We
# don't restrict to this set — any 2-letter alpha matches the heuristic
# — but it documents the corpus we actually ingest.
COMMON_LANGS: set[str] = {
    "fr", "en", "de", "es", "it", "pt", "nl", "sv", "no", "da",
    "fi", "pl", "cs", "hu", "ro", "ru", "uk", "tr", "ar", "fa",
    "he", "zh", "ja", "ko", "vi", "th", "id", "hi", "bn",
}
