"""
Wikipedia + Wikidata client — entity candidate generation + enrichment.

# Why this combo (after a long detour)

We tried Wikidata's `wbsearchentities` first; it matches on formal
labels and aliases only. Wikidata doesn't have "Trump" as a formal
alias of Donald Trump (Q22686) — his aliases are "President Trump",
"DJT", etc. So `wbsearchentities("Trump", ...)` returns the surname
disambiguation page, not the politician.

Wikipedia's API is smarter: it knows that the page "Trump" REDIRECTS
to "Donald Trump" (because that's the most-viewed meaning), and the
"Donald Trump" page has `pageprops.wikibase_item = Q22686`. So one
Wikipedia call resolves "Trump" → Q22686 cleanly. Same for "Anthropic",
"Putin", "Paris", etc.

For genuinely ambiguous surfaces ("Vance", "BCE", "Apple"), the
Wikipedia full-text search returns the top-N most-likely candidates,
each with their Wikidata Q-id. Our LLM disambiguator then picks the
right one using the article context.

# Two operations this module handles

  - **search(surface, kind, lang)** → list of candidate Q-id + metadata.
    Hits Wikipedia's `query` (direct title with redirects) and falls
    back to `query?list=search` (full-text). Returns Wikidata Q-ids
    extracted from each candidate page's `pageprops.wikibase_item`.

  - **enrich(qid, kind, langs)** → full entity payload from Wikidata
    (`wbgetentities`): canonical EN label, description, country,
    instance_of, industry, label translations, aliases (all langs),
    image URL. Used the moment we decide a Q-id is the right match.

# Etiquette

Both Wikipedia and Wikidata are free public APIs. They ask:
  1. A distinguishing User-Agent header — we send `Veilla/1.0`.
  2. Politeness — semaphore caps concurrent calls at 8.

Retries: 1 immediate retry on connection error / 5xx, then return
None. The resolver tolerates None and marks the mention as `unlinked`
so curation can pick it up later.

The module is stateless apart from the semaphore — safe to call from
multiple worker threads concurrently.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass

import requests

_log = logging.getLogger(__name__)


# Conservative cap on simultaneous Wikidata calls. The library `requests`
# uses a connection-pool of 10 by default; we leave a couple slots for
# unrelated HTTPS calls in the same worker process.
_WIKIDATA_CONCURRENCY = 8
_wikidata_semaphore = threading.Semaphore(_WIKIDATA_CONCURRENCY)

# Single shared session — connection reuse trims ~80ms off each call vs
# a fresh TLS handshake. requests.Session is thread-safe at the level we
# use it (GETs only, no mutation).
_session = requests.Session()
_session.headers.update({
    "User-Agent": "Veilla/1.0 (https://veilla.io; mario@veilla.io)",
    "Accept":     "application/json",
})

_WIKIDATA_API = "https://www.wikidata.org/w/api.php"
_REQUEST_TIMEOUT = 10  # seconds

# Wikipedia API base. We default to English Wikipedia because our
# pipeline normalizes everything to English upstream (the
# `summary_normalized` field). For multilingual content we could later
# parametrize this, but EN is the right default for now and has the
# best entity coverage.
_WIKIPEDIA_API_TEMPLATE = "https://{lang}.wikipedia.org/w/api.php"

# Markers in Wikidata short descriptions that mean "this is a
# disambiguation / placeholder page, not a real entity". We use them
# to filter candidates returned by Wikipedia search before showing
# them to the LLM. Lowercase comparison.
#
# Includes name-of-people pages ("Trump (family name)", "John (given
# name)") because they're never the answer for an entity-link query —
# we want the specific human, not the surname article.
_DISAMBIG_DESC_MARKERS = (
    "topics referred to by the same term",
    "wikipedia disambiguation page",
    "wikimedia disambiguation page",
    "wikimedia category",
    "wikimedia list article",
    "list of",
    "may refer to",
    "family name",
    "given name",
    "surname",
    "first name",
    "patronymic",
)


@dataclass(frozen=True)
class WikidataCandidate:
    """A candidate Q-id surfaced by Wikipedia search.

    Carries enough metadata for the LLM disambiguator to make a decision
    without an extra round-trip. The `is_disambiguation_page` flag is
    set when the underlying Wikipedia page exists only to list other
    pages (Trump (surname), BCE (disambiguation), etc.) — the resolver
    filters these out before the disambig step.
    """
    qid:                 str
    label:               str             # Wikipedia page title
    description:         str | None   # Wikidata short description if any
    aliases_in_search_lang: tuple[str, ...]   # mostly empty for Wikipedia-search hits
    is_disambiguation_page: bool = False

    @property
    def numeric_id(self) -> int:
        """For ordering by Q-id when Wikipedia returns ties (lower = older
        = usually more notable). Used as a final tiebreaker."""
        return int(self.qid[1:]) if self.qid.startswith("Q") else 10**12


@dataclass(frozen=True)
class WikidataEntity:
    """Fully enriched entity, ready to INSERT into our `entities` table."""
    qid:                 str
    canonical_label:     str             # always EN, falls back to first available
    description:         str | None
    country:             str | None   # ISO alpha-2 if derivable
    instance_of:         tuple[str, ...] # EN labels of P31 values
    industry:            str | None   # EN label of P452 (orgs)
    aliases:             tuple[str, ...] # all known surface forms, all langs
    label_translations:  dict[str, str]  # ISO 639-1 → label
    image_url:           str | None   # full URL to commons image


def search(surface: str, kind: str, lang: str = "en",
           limit: int = 5) -> list[WikidataCandidate]:
    """Generate candidate Q-ids for `surface` via Wikipedia.

    Two-step strategy mirroring how a human would look up "Trump" in
    an encyclopedia:

      1. **Direct title lookup** — `query?titles=<surface>&redirects=1`.
         If Wikipedia has a page literally named `surface` (after
         redirect resolution), and it's NOT a disambiguation page,
         return it as the single high-confidence candidate. This
         handles the bulk of clearly-named entities: "Donald Trump",
         "Anthropic", "European Central Bank", "Paris".

      2. **Full-text search fallback** — `query?list=search`. Used
         when step 1 lands on a disambiguation page OR returns
         nothing. Wikipedia's search index uses anchor-text frequency,
         redirects, and pageview popularity to rank candidates — so
         "Vance" returns JD Vance ahead of his less-famous namesakes.
         We then batch-fetch each candidate's `pageprops.wikibase_item`
         to get the Q-id.

    Why this works while `wbsearchentities` doesn't: Wikidata's alias
    list for an entity is human-curated and incomplete. "Trump" isn't
    formally in Q22686's aliases. But Wikipedia's "Trump" page IS a
    redirect to "Donald Trump" (curated by the community via the page
    redirect mechanism). Both endpoints sit on top of the same live
    data; Wikipedia is just the smarter index for surface-form
    resolution.

    `kind` is passed through to the resolver — actual kind-based
    filtering happens at disambig time (we don't filter here because
    even disambig pages can be useful as a signal in the LLM prompt).

    `lang` selects which Wikipedia to query. We default to English
    because our pipeline normalizes everything to English upstream.
    """
    if not surface or not surface.strip():
        return []

    surface = surface.strip()
    api_url = _WIKIPEDIA_API_TEMPLATE.format(lang=(lang or "en"))

    # Step 1: direct title resolution.
    direct = _wikipedia_resolve_title(api_url, surface)
    if direct is not None and not direct.is_disambiguation_page:
        return [direct]

    # Step 2: full-text search. We may also already have a disambig
    # page from step 1 — its absence vs presence doesn't change the
    # next call. We DON'T include the disambig candidate in the
    # results because it's useless to the LLM.
    return _wikipedia_search_candidates(api_url, surface, limit=limit)


def _wikipedia_resolve_title(api_url: str, surface: str) -> WikidataCandidate | None:
    """One call to Wikipedia's `query` action with redirect resolution.
    Returns the resolved candidate or None on miss / network failure.

    Detects disambiguation pages via `pageprops.disambiguation` (a Wikipedia
    page property that's present iff the page uses the {{disambiguation}}
    template) and by description fallback. If we detect a disambig page,
    we still return it but flag it via `is_disambiguation_page=True` so
    the caller knows to fall back to search.
    """
    params = {
        "action":    "query",
        "format":    "json",
        "titles":    surface,
        "redirects": 1,
        "prop":      "pageprops",
        "ppprop":    "wikibase_item|disambiguation|wikibase-shortdesc",
    }
    data = _get_json(params, base_url=api_url)
    if not data:
        return None

    pages = (data.get("query") or {}).get("pages") or {}
    if not pages:
        return None

    # Pick the first non-missing page (Wikipedia returns multiple if
    # the title is plural / matches several pages — rare for single
    # surfaces but handled).
    for raw in pages.values():
        if raw.get("missing") is not None:
            continue
        pp = raw.get("pageprops") or {}
        qid = pp.get("wikibase_item")
        if not isinstance(qid, str) or not qid.startswith("Q"):
            continue
        title = raw.get("title") or surface
        desc  = pp.get("wikibase-shortdesc")
        is_disambig = "disambiguation" in pp or (
            desc and any(m in desc.lower() for m in _DISAMBIG_DESC_MARKERS)
        )
        return WikidataCandidate(
            qid=qid,
            label=title,
            description=desc,
            aliases_in_search_lang=(),
            is_disambiguation_page=bool(is_disambig),
        )
    return None


def search_full_text(
    surface: str, kind: str, lang: str = "en", limit: int = 5,
) -> list[WikidataCandidate]:
    """Force the full-text Wikipedia search path, skipping direct title
    resolution.

    Used by the resolver as a fallback when the direct-title result was
    filtered out (e.g. Wikipedia's primary meaning for "Apple" is the
    fruit, but the article context says org → we need the search step
    to discover Apple Inc. and friends).
    """
    if not surface or not surface.strip():
        return []
    api_url = _WIKIPEDIA_API_TEMPLATE.format(lang=(lang or "en"))
    return _wikipedia_search_candidates(api_url, surface.strip(), limit=limit)


def _wikipedia_search_candidates(
    api_url: str, surface: str, limit: int = 5,
) -> list[WikidataCandidate]:
    """Full-text Wikipedia search → top-N hits → batch-fetch each
    page's Wikidata Q-id + description in one extra round-trip.

    We deliberately pull `limit + 2` from search to allow filtering
    disambig pages without dropping below `limit` real candidates.
    """
    # First: search.
    search_params = {
        "action":   "query",
        "format":   "json",
        "list":     "search",
        "srsearch": surface,
        "srlimit":  str(max(1, min(limit + 2, 10))),
        "srprop":   "snippet",
    }
    data = _get_json(search_params, base_url=api_url)
    if not data:
        return []
    hits = ((data.get("query") or {}).get("search")) or []
    if not hits:
        return []

    titles = [h["title"] for h in hits if h.get("title")]
    if not titles:
        return []

    # Second: batch-resolve Q-ids + descriptions for those titles.
    props_params = {
        "action":    "query",
        "format":    "json",
        "titles":    "|".join(titles),
        "redirects": 1,
        "prop":      "pageprops",
        "ppprop":    "wikibase_item|disambiguation|wikibase-shortdesc",
    }
    props_data = _get_json(props_params, base_url=api_url)
    if not props_data:
        return []
    pages = ((props_data.get("query") or {}).get("pages")) or {}

    # Build a lookup from canonical title (after redirect) → page data.
    redirects = ((props_data.get("query") or {}).get("redirects")) or []
    redirect_map = {r["from"]: r["to"] for r in redirects if r.get("from") and r.get("to")}

    by_title: dict[str, dict] = {p["title"]: p for p in pages.values() if "title" in p}

    out: list[WikidataCandidate] = []
    seen_qids: set[str] = set()
    for title in titles:
        resolved_title = redirect_map.get(title, title)
        p = by_title.get(resolved_title) or by_title.get(title)
        if not p or p.get("missing") is not None:
            continue
        pp = p.get("pageprops") or {}
        qid = pp.get("wikibase_item")
        if not isinstance(qid, str) or not qid.startswith("Q"):
            continue
        if qid in seen_qids:
            continue
        seen_qids.add(qid)
        desc = pp.get("wikibase-shortdesc")
        is_disambig = "disambiguation" in pp or (
            desc and any(m in desc.lower() for m in _DISAMBIG_DESC_MARKERS)
        )
        out.append(WikidataCandidate(
            qid=qid,
            label=p.get("title") or title,
            description=desc,
            aliases_in_search_lang=(),
            is_disambiguation_page=bool(is_disambig),
        ))
        if len(out) >= limit:
            break
    return out


def _pick_canonical_label(labels: dict) -> str | None:
    """Pick the best canonical label from a Wikidata `labels` payload.

    Preference order:
      1. `"en"`  — English label, the documented home of canonical_label.
      2. `"mul"` — Wikidata's multilingual pseudo-language. Editorial
                   convention for names that read identically across
                   latin-script languages: rather than duplicating
                   "Donald Trump" under en/fr/es/it/de/…, Wikidata
                   stores it once as `"mul"`. Q22686 is the canonical
                   example — it has NO `"en"` entry at all (verified
                   against the live Wikidata API).
      3. First non-empty label by alphabetic key — last-resort
                   deterministic fallback. Without the `"mul"` step
                   above, Q22686 would land on `"ab"` (Abkhaz, cyrillic
                   script) → "Дональд Трамп".

    Returns None when no usable label is found.
    """
    for L in ("en", "mul"):
        v = (labels.get(L) or {}).get("value")
        if isinstance(v, str) and v.strip():
            return v
    for L in sorted(labels.keys()):
        v = (labels.get(L) or {}).get("value")
        if isinstance(v, str) and v.strip():
            return v
    return None


def enrich(
    qid: str,
    *,
    kind: str | None = None,
    langs: tuple[str, ...] | None = None,
) -> WikidataEntity | None:
    """Fetch the full entity payload via `wbgetentities`.

    Pulls labels + aliases + descriptions across all available languages
    by default (`langs=None`). For multilingual news monitoring this is
    the right behavior — once an entity is resolved, its alias array
    contains every surface form in every language Wikidata has data
    for, so future articles in any language hit the local cache. The
    extra payload size (~5-10KB JSON vs ~500 bytes) is paid once per
    entity, then we read from our own DB.

    Pass an explicit `langs` tuple to limit (e.g. during a test) — the
    function dedups and always includes EN since canonical_label uses
    it as the primary fallback.

    Property values pulled from claims:
      - P31 (instance_of)
      - P452 (industry — orgs only)
      - P18  (image)
      - Country: P17 by default, but for persons we fall back to P27
        (country of citizenship) since humans don't have P17. Pass
        `kind='person'` to prefer P27 directly.

    Returns None on parse error or HTTP failure — caller treats that as
    "we can't enrich right now, fall back to a minimal entity row".
    """
    if not qid or not qid.startswith("Q"):
        return None

    params = {
        "action":    "wbgetentities",
        "format":    "json",
        "ids":       qid,
        "props":     "labels|descriptions|aliases|claims|sitelinks/urls",
        "sitefilter": "enwiki",
    }
    # If the caller restricts languages, honor it; otherwise let Wikidata
    # return everything.
    if langs:
        seen, all_langs = set(), []
        for L in ("en", *langs):
            if L and L not in seen:
                seen.add(L)
                all_langs.append(L)
        params["languages"] = "|".join(all_langs)

    data = _get_json(params)
    if not data:
        return None

    raw = (data.get("entities") or {}).get(qid)
    if not isinstance(raw, dict):
        return None

    labels = raw.get("labels") or {}
    canonical = _pick_canonical_label(labels)
    if not canonical:
        return None

    # Description: prefer EN, fall back to first available.
    descs = raw.get("descriptions") or {}
    description = (descs.get("en") or {}).get("value")
    if not description:
        for L in sorted(descs.keys()):
            v = (descs.get(L) or {}).get("value")
            if v:
                description = v
                break

    # Label translations across every language Wikidata returned.
    label_translations = {
        L: (labels.get(L) or {}).get("value")
        for L in labels.keys()
        if isinstance((labels.get(L) or {}).get("value"), str)
           and (labels.get(L) or {}).get("value").strip()
    }

    # Aliases: union of every alias array across every returned lang +
    # all label values (the label IS a known surface form).
    aliases_set: set[str] = set()
    for L, lst in (raw.get("aliases") or {}).items():
        if not isinstance(lst, list):
            continue
        for a in lst:
            v = (a or {}).get("value")
            if isinstance(v, str) and v.strip():
                aliases_set.add(v.strip())
    for L, lab in labels.items():
        v = (lab or {}).get("value")
        if isinstance(v, str) and v.strip():
            aliases_set.add(v.strip())

    # Country: kind-aware. Humans have citizenship (P27), not location
    # (P17). Other kinds (orgs, locations, events) use P17. When the
    # caller didn't tell us the kind, try P17 then fall back to P27.
    claims = raw.get("claims") or {}
    instance_of_qids = _extract_claim_qids(claims, "P31")
    industry_qid     = (_extract_claim_qids(claims, "P452") or [None])[0]
    image_filename   = _extract_image_filename(claims)

    if kind == "person":
        country_qid = (_extract_claim_qids(claims, "P27") or
                       _extract_claim_qids(claims, "P17") or [None])[0]
    else:
        country_qid = (_extract_claim_qids(claims, "P17") or
                       _extract_claim_qids(claims, "P27") or [None])[0]

    # Resolve the property Q-id values to human labels via a single
    # follow-up wbgetentities call. We only need EN labels here.
    label_qid_resolve_targets: list[str] = [q for q in instance_of_qids if q]
    if country_qid:  label_qid_resolve_targets.append(country_qid)
    if industry_qid: label_qid_resolve_targets.append(industry_qid)
    qid_to_label = _resolve_qid_labels(label_qid_resolve_targets) if label_qid_resolve_targets else {}

    instance_of = tuple(
        qid_to_label[q] for q in instance_of_qids
        if q in qid_to_label
    )
    industry = qid_to_label.get(industry_qid) if industry_qid else None

    country_iso = _country_qid_to_iso(country_qid) if country_qid else None

    image_url = _commons_image_url(image_filename) if image_filename else None

    return WikidataEntity(
        qid                = qid,
        canonical_label    = canonical,
        description        = description,
        country            = country_iso,
        instance_of        = instance_of,
        industry           = industry,
        aliases            = tuple(sorted(aliases_set)),
        label_translations = label_translations,
        image_url          = image_url,
    )


# ── Internals ──────────────────────────────────────────────────────────


def _get_json(params: dict, base_url: str | None = None) -> dict | None:
    """GET wrapped in the semaphore + 1 retry on transient errors.

    `base_url` lets callers target Wikipedia (`https://en.wikipedia.org/
    w/api.php`) or any other MediaWiki API. Defaults to Wikidata.

    Returns the parsed JSON dict or None on any failure.
    """
    url = base_url or _WIKIDATA_API
    with _wikidata_semaphore:
        for attempt in (0, 1):
            try:
                r = _session.get(url, params=params, timeout=_REQUEST_TIMEOUT)
                if r.status_code == 429:
                    # Rate limited. Sleep the Retry-After header (or 1s)
                    # and retry exactly once.
                    delay = float(r.headers.get("Retry-After", "1") or "1")
                    time.sleep(min(delay, 5.0))
                    continue
                if 500 <= r.status_code < 600 and attempt == 0:
                    time.sleep(0.5)
                    continue
                if r.status_code != 200:
                    _log.warning("MediaWiki API %s on %s (host=%s)",
                                 r.status_code, params.get("action"), url)
                    return None
                return r.json()
            except (requests.RequestException, ValueError) as e:
                if attempt == 0:
                    time.sleep(0.5)
                    continue
                _log.warning("wikidata API error after retry: %s", e)
                return None
    return None


def _extract_claim_qids(claims: dict, prop: str) -> list[str]:
    """Pull the Q-id values for a given property. Wikidata's claim shape
    is deeply nested; we tolerate gaps and skip non-item values silently."""
    out: list[str] = []
    for c in claims.get(prop) or []:
        try:
            datavalue = c["mainsnak"]["datavalue"]
            if datavalue.get("type") != "wikibase-entityid":
                continue
            qid = datavalue["value"]["id"]
            if isinstance(qid, str) and qid.startswith("Q"):
                out.append(qid)
        except (KeyError, TypeError):
            continue
    return out


def _extract_image_filename(claims: dict) -> str | None:
    """P18 (image) is a string datavalue with the Commons filename."""
    for c in claims.get("P18") or []:
        try:
            dv = c["mainsnak"]["datavalue"]
            if dv.get("type") == "string" and isinstance(dv.get("value"), str):
                return dv["value"]
        except (KeyError, TypeError):
            continue
    return None


def _commons_image_url(filename: str) -> str:
    """Build the canonical Special:FilePath URL — handles the MD5
    bucketing for us, no need to compute the path ourselves."""
    safe = filename.replace(" ", "_")
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{safe}"


# Common country Q-ids → ISO alpha-2. Hardcoded for the most-frequent
# heads; falls back to `None` for the long tail (we'll still have the
# Q-id, we just won't expose a 2-letter code). Extending this list is
# cheap if we hit a frequent miss in prod.
_COUNTRY_QID_TO_ISO = {
    "Q30":   "US", "Q142":  "FR", "Q183":  "DE", "Q145":  "GB",
    "Q38":   "IT", "Q29":   "ES", "Q31":   "BE", "Q55":   "NL",
    "Q39":   "CH", "Q40":   "AT", "Q34":   "SE", "Q35":   "DK",
    "Q20":   "NO", "Q33":   "FI", "Q36":   "PL", "Q43":   "TR",
    "Q668":  "IN", "Q148":  "CN", "Q17":   "JP", "Q884":  "KR",
    "Q252":  "ID", "Q833":  "MY", "Q334":  "SG", "Q865":  "TW",
    "Q408":  "AU", "Q664":  "NZ", "Q414":  "AR", "Q155":  "BR",
    "Q298":  "CL", "Q739":  "CO", "Q717":  "VE", "Q419":  "PE",
    "Q96":   "MX", "Q241":  "CU", "Q16":   "CA",
    "Q794":  "IR", "Q796":  "IQ", "Q801":  "IL", "Q805":  "YE",
    "Q810":  "JO", "Q811":  "PS", "Q822":  "LB", "Q858":  "SY",
    "Q851":  "SA", "Q878":  "AE", "Q846":  "QA", "Q817":  "KW",
    "Q664609": "BH", "Q842":  "OM", "Q79":   "EG", "Q1041": "SN",
    "Q1033": "NG", "Q1009": "CM", "Q1019": "MG", "Q953":  "ZM",
    "Q258":  "ZA", "Q1027": "MU", "Q1029": "MZ", "Q967":  "BI",
    "Q924":  "TZ", "Q1030": "NA", "Q1005": "GM", "Q1014": "LR",
    "Q1006": "GN", "Q1008": "CI", "Q1013": "LS", "Q1016": "LY",
    "Q1028": "MA", "Q1032": "NE", "Q1036": "UG", "Q1037": "RW",
    "Q1039": "ST", "Q1042": "SC", "Q1045": "SO", "Q1049": "SD",
    "Q403":  "RS", "Q41":   "GR", "Q224":  "HR", "Q189":  "IS",
    "Q211":  "LV", "Q37":   "LT", "Q191":  "EE", "Q214":  "SK",
    "Q213":  "CZ", "Q28":   "HU", "Q218":  "RO", "Q219":  "BG",
    "Q215":  "SI", "Q227":  "AZ", "Q230":  "GE", "Q399":  "AM",
    "Q159":  "RU", "Q212":  "UA", "Q184":  "BY",
    "Q45":   "PT", "Q229":  "CY", "Q233":  "MT",
}


def _country_qid_to_iso(qid: str) -> str | None:
    return _COUNTRY_QID_TO_ISO.get(qid)


def _resolve_qid_labels(qids: list[str]) -> dict[str, str]:
    """Bulk-label resolver: maps each Q-id to its EN label via a single
    `wbgetentities` call. Used to translate P31/P452 Q-id values into
    human-readable labels (e.g. Q82955 → "politician").

    Wikidata accepts up to 50 ids per call; we slice into chunks to
    play nice even if we ever exceed that.
    """
    out: dict[str, str] = {}
    uniq = sorted({q for q in qids if isinstance(q, str) and q.startswith("Q")})
    if not uniq:
        return out

    for i in range(0, len(uniq), 50):
        chunk = uniq[i:i + 50]
        data = _get_json({
            "action":    "wbgetentities",
            "format":    "json",
            "ids":       "|".join(chunk),
            "props":     "labels",
            "languages": "en",
        })
        if not data:
            continue
        for qid, raw in (data.get("entities") or {}).items():
            label = ((raw.get("labels") or {}).get("en") or {}).get("value")
            if isinstance(label, str) and label.strip():
                out[qid] = label.strip()
    return out


__all__ = ["search", "enrich", "WikidataCandidate", "WikidataEntity"]
