"""
Article metadata extraction — the second LLM call (Call B).

Reads the normalized output of `src/normalizer.py` (title_normalized,
summary_full, lang) and asks the LLM for:

  - article_type  (news | feature | opinion | interview | recap | multimedia | institutional)
  - categories    (1..2 picks from the 16-bucket taxonomy)
  - keywords      (5..8 thematic concepts)
  - countries     (≤5 ISO alpha-2 or 3-letter regional codes, GLB for global)
  - entities      (persons / orgs / locations / events / markets / products, ≤3 each)

Why a second call:
  - the model now sees CLEAN English text instead of a raw multilingual
    title — entity recognition + topic alignment are markedly more
    consistent;
  - the system prompt fits the smaller context comfortably;
  - failure modes are isolated: a transient extract failure leaves the
    article fully readable (title, summary, summary_full all populated)
    and is retried next pass.

DB write contract:
  - this module writes ONLY: `category`, `keywords`, `countries`,
    `entities`, `article_type`.
  - everything else (title, title_normalized, summary_*, lang) is left
    untouched.

Pending detection:
  - `title_normalized IS NOT NULL AND entities IS NULL`.
  - `entities IS NULL` is the sentinel for "Call B never ran" — Call A
    no longer writes entities so the NULL is reliable.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from openai import OpenAI

from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL
from src.taxonomy import CATEGORIES
from src.validation import (
    record_validation_warning,
    validate_article_type,
    validate_categories,
    validate_countries,
    validate_entities,
    validate_keywords,
)

MODEL      = TEXT_MODEL

# Bare country / region names that should never appear as org entities.
# "French Government" passes (contains extra word); "France" or "United
# States" alone fails. Kept lowercase for cheap comparison.
_BARE_COUNTRY_NAMES = {
    "afghanistan", "albania", "algeria", "angola", "argentina", "armenia",
    "australia", "austria", "azerbaijan", "bahrain", "bangladesh", "belarus",
    "belgium", "bolivia", "bosnia", "brazil", "bulgaria", "cambodia",
    "cameroon", "canada", "chile", "china", "colombia", "congo", "croatia",
    "cuba", "cyprus", "czech republic", "denmark", "ecuador", "egypt",
    "estonia", "ethiopia", "finland", "france", "georgia", "germany",
    "ghana", "greece", "guatemala", "honduras", "hungary", "iceland",
    "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy",
    "ivory coast", "jamaica", "japan", "jordan", "kazakhstan", "kenya",
    "kuwait", "latvia", "lebanon", "libya", "lithuania", "luxembourg",
    "malaysia", "mali", "malta", "mexico", "moldova", "morocco",
    "mozambique", "myanmar", "netherlands", "new zealand", "nicaragua",
    "nigeria", "north korea", "norway", "oman", "pakistan", "panama",
    "paraguay", "peru", "philippines", "poland", "portugal", "qatar",
    "romania", "russia", "saudi arabia", "senegal", "serbia", "singapore",
    "slovakia", "slovenia", "somalia", "south africa", "south korea",
    "south sudan", "spain", "sri lanka", "sudan", "sweden", "switzerland",
    "syria", "taiwan", "tanzania", "thailand", "tunisia", "turkey",
    "ukraine", "united arab emirates", "uae", "united kingdom", "uk",
    "united states", "united states of america", "us", "usa", "uruguay",
    "uzbekistan", "venezuela", "vietnam", "yemen", "zimbabwe",
    "europe", "european union", "eu", "asia", "africa", "middle east",
    "latin america", "south america", "north america", "oceania",
    "southeast asia", "central asia", "eastern europe", "western europe",
    "sub-saharan africa", "north africa",
}


_CATEGORY_LIST = "\n".join(f"{i+1}. {name}" for i, name in enumerate(CATEGORIES))


_RULES = f"""You are a news editor extracting structured metadata from already-normalized articles. The input has been pre-translated to clean English. Your task: produce a JSON object with the following fields.

GENERAL RULES:
- Use clean English, no accents (e.g. Cedric, Raphael, Lodz).
- Be factual and consistent. Use only the provided content.
- Return ONLY the JSON object. No markdown, no explanations.
- If the input title or summary is empty, return safe defaults: article_type="news", categories=[], keywords=[], countries=[], entities={{"persons":[], "orgs":[], "locations":[], "events":[], "markets":[], "products":[]}}.

---

"article_type": classify the article format. One of exactly:
  "news" | "feature" | "opinion" | "interview" | "recap" | "multimedia" | "institutional"
  - news: standard factual news report, breaking news, news brief. Default — use when in doubt.
  - feature: in-depth analysis, investigation, long-form contextual piece, explainer. Substantive and analytical, not opinionated.
  - opinion: editorial, column, op-ed, chronicle, commentary. Written from an explicit personal or editorial perspective.
  - interview: Q&A, conversation, dialogue. Article primarily structured around an interview format.
  - recap: roundup, digest, revue de presse, daily/weekly summary, multi-topic wrap-up. Covers several different stories without a single central fact. Use this for "Market Talk", "Roundup", "Morning Brief", etc.
  - multimedia: video, podcast, audio broadcast, photo gallery. Primarily non-text format with little or no written article content.
  - institutional: official press release, government communique, institutional report, official statistics release. Source is an institution publishing in an official capacity (Eurostat, IMF, central banks, ministries, international organizations).

"categories": classify into 1 category, or 2 only if the article clearly spans two distinct domains (rare — when in doubt, use 1).
  If 2 categories, put the most relevant first.
  Return a JSON array of integers referencing the list below.
  Example: [1] or [5, 7]

Categories:
{_CATEGORY_LIST}
  1. Domestic Politics — government, parliament, parties, elections, domestic policy. Ex: cabinet reshuffle, national budget, primaries, parliamentary life
  2. Geopolitics & Conflicts — inter-state relations, wars, diplomacy, sanctions, alliances. Ex: Iran war, NATO, Russia sanctions, diplomatic visit
  3. Justice & Legal Affairs — trials, court rulings, corruption, passed laws, investigations. Ex: Sarkozy trial, adopted bill, court ruling
  4. Crime & Public Safety — crime, serious accidents, disasters, emergencies. Ex: train accident, attack, fire, major crime
  5. Economy — macro outlook, growth, inflation, central banks, public debt. Ex: GDP, deficit, ECB, Fed, OECD forecasts, recession
  6. Finance & Markets — financial markets, stocks, bonds, commodities, M&A, earnings. Ex: CAC 40, oil price, merger, earnings, sovereign bonds
  7. Business & Industry — corporate strategy, sectors, production, factories, industrial sovereignty. Ex: plant closure, Renault strategy, aerospace sector
  8. Energy & Climate — energy infrastructure, transition, climate policy. Ex: EDF, climate law, COP, fuel prices, nuclear
  9. Technology & AI — digital, AI, startups, cybersecurity, platforms, tech regulation. Ex: AI model, French Tech, cyberattack, GDPR
  10. Science — academic research, discoveries, publications, studies. Ex: CNRS study, space research, medical publication
  11. Health — healthcare system, drugs, health policy, epidemics. Ex: sick leave, social security, drug prices, hospitals
  12. Society & Labour — social movements, unions, inequalities, immigration, working conditions. Ex: strike, racism, poverty, undocumented workers, burnout
  13. Education — teaching, training, apprenticeship, education policy. Ex: school reform, university, vocational training
  14. Media & Culture — media, broadcasting, press, cinema, music, arts, books. Ex: France Televisions, Netflix, festival, exhibition
  15. Sport — competitions, results, transfers, sports economy. Ex: Ligue 1, Tour de France, transfer, club financing
  16. Other — does not fit any category above.

Ambiguity tie-breakers (apply in order, stop at the first that resolves):
  - The article's EXPLICIT angle (what is the lede about?). Macro inflation framed as a political fight → 1 + 5; framed as ECB policy → 5 + 6.
  - The DOMINANT named entities. Mostly central bank speeches → 5/6, not 1.
  - The PUBLISHER ORIENTATION (provided in input). A finance outlet talking about a corporate scandal usually wants 6 + 3, not 4.
  - When still tied: pick the more specific bucket over Other.

"keywords": 5 to 8 thematic keywords capturing the topic and subject matter.
  - Concepts and themes only — NO persons, companies, or locations.
  - Prefer specific, stable, reusable concepts. Always in English.
  - Example for a tax digitization article: ["income tax declaration", "tax digitization", "fiscal administration", "paperless filing", "tax compliance"]
  - Example for an industrial output article: ["industrial output", "economic contraction", "manufacturing decline", "supply shock", "industrial competitiveness"]

"countries": list of up to 5 geographic codes for countries or regions this article significantly covers or impacts.
  Allowed values:
    - ISO alpha-2 codes for specific countries: FR, US, IR, JP, ME (Montenegro), AF (Afghanistan), AS (American Samoa), etc.
    - THREE-LETTER regional codes for broad zones:
        "EUR" (Europe/EU broadly), "ASI" (Asia broadly), "MID" (Middle East broadly),
        "AFR" (Africa broadly), "LAT" (Latin America/Caribbean broadly), "OCE" (Oceania/Pacific broadly).
    - "GLB" (Global) — for articles with truly worldwide scope where no specific region dominates.
  IMPORTANT: NEVER use 2-letter regional codes like "EU", "ME", "AS", "AF" as broad-zone codes — those 2-letter strings are ISO alpha-2 codes for specific countries (Montenegro, American Samoa, Afghanistan, etc.) and would be ambiguous. Always use the 3-letter regional forms.
  Rules:
  - Include where events take place, what caused them, and what is directly impacted.
  - Use regional codes when no specific country is named; combine both if needed: ["IR", "KR", "ASI"].
  - When an article discusses markets, economies or industries of a broad region, include the regional code even if a specific event is the cause.
  - Use "GLB" ONLY when the article EXPLICITLY discusses worldwide impact or scope.
  - If the article clearly targets a domestic audience with no other geography identifiable, use the source country (provided in input) if relevant.
  - Use the source country only to disambiguate place names you cannot resolve from context alone.
  - Empty list [] if no geography is clearly relevant.
  Examples:
  - Iran war impact on Asian equities → ["IR", "ASI"]
  - Google acquires Japanese firm → ["US", "JP"]
  - EU Commission warns on stagflation → ["EUR"]
  - French AI startup raises funding → ["FR"]
  - IMF cuts global growth forecast → ["GLB"]

"entities": named entities most relevant to this article, grouped by type. Up to 3 per type.
  Use the same normalization rules as title_normalized: English, no accents.
  Translate international organization acronyms to their English canonical form (OTAN->NATO, ONU->UN, UE->EU, BCE->ECB).
  IMPORTANT — Output the FULL CANONICAL NAME, not the short surface form used in the article.
    These names feed an entity-linking step that matches them against Wikipedia / Wikidata canonical labels.
    Surnames-only and acronyms typically DON'T match (Wikidata's primary label for the politician is "Donald Trump", not "Trump"), so producing them breaks linking.
  For persons:
    - The article context tells you WHO is being referred to. Use that knowledge to output the canonical full name they're known by.
    - "Trump signed an order yesterday" → output "Donald Trump" (the article is about the US president).
    - "Macron a rencontre les syndicats" → output "Emmanuel Macron".
    - "Vance defended the policy" in a Trump-administration context → output "JD Vance".
    - When the article EXPLICITLY narrows it to a less-famous person of the same surname (e.g. an interview with "Cyrus Vance about 1970s diplomacy"), output THAT canonical name.
    - Only output a bare surname if no canonical full name can be inferred from context — this should be rare.
    - Never fabricate a first name when context doesn't tell you who's meant. Output the surname alone in that case.
  For orgs:
    - Output the full English canonical name (e.g. "European Central Bank", not "ECB"; "International Monetary Fund", not "IMF" — though IMF is its own canonical English form, while "BCE" in a French article should become "European Central Bank").
    - For common-word brands ("Apple", "Amazon", "Meta"), output the disambiguated form ("Apple Inc.", "Amazon", "Meta Platforms").
  Types:
  - "persons": public figures who are the **subject** of the article — politicians, executives, officials
    whose actions, decisions, or statements the article is about.
    Not journalists, reporters, columnists, hosts, presenters, anchors, or authors of the article or show.
    Not experts, analysts, or witnesses merely quoted or interviewed unless they are themselves the main subject.
  - "orgs": named organizations directly relevant to the article: companies, brands, political parties,
    associations, institutions, central banks, international bodies, trade unions, NGOs, think tanks.
    Not person names, not country names.
    Do not include the publisher/source of this article unless it is genuinely the subject of the news
    (e.g. the article covers that outlet's editorial decisions, financial results, or legal troubles).
  - "locations": any explicitly named geographic place below the country level:
    cities, neighborhoods, regions, rivers, mountains, seas, oceans, straits, landmarks, sites.
    NOT countries, continents, or broad regions (those go in "countries").
  - "events": named scheduled or unscheduled events with a fixed name:
    international summits ("Davos 2026", "G7 summit", "COP30"), conferences ("Vivatech", "Web Summit"),
    sporting finals ("Champions League final", "Roland-Garros"), national elections by year ("French
    presidential election 2027"), named operations / strikes / military campaigns.
    NOT generic event categories ("a strike", "elections") — only specifically named events.
  - "markets": named market instruments, indices, commodities, or currencies materially discussed:
    "CAC 40", "S&P 500", "Nikkei 225", "Brent crude", "WTI", "Bitcoin", "EUR/USD", "10-year Treasury",
    "OAT 10Y", "Bund 10Y".
    NOT generic terms ("the stock market", "bond yields") — only the specific named instruments.
  - "products": named products, services, models, or platforms that are the SUBJECT of the article:
    "ChatGPT", "GPT-5", "iPhone 16", "F-35", "Eurofighter", "Wegovy", "Cybertruck", "Rafale".
    NOT generic product categories ("AI assistants", "smartphones") — only specifically named products.
  Do not include countries or broad regions in any entity field.
  Do not include generic terms or common nouns.
  Empty list [] for any type with no clearly relevant entity.
  Format: {{"persons": [], "orgs": [], "locations": [], "events": [], "markets": [], "products": []}}
  Examples (notice: bare surnames and acronyms get expanded to their canonical form):
  - "Lecornu demands fuel price drop by end of weekend" (PM of France context)
    → {{"persons": ["Sebastien Lecornu"], "orgs": [], "locations": [], "events": [], "markets": [], "products": []}}
  - "TotalEnergies refinery shut after Iran conflict damage"
    → {{"persons": [], "orgs": ["TotalEnergies"], "locations": [], "events": [], "markets": ["Brent crude"], "products": []}}
  - "Macron and Scholz meet in Paris ahead of NATO summit"
    → {{"persons": ["Emmanuel Macron", "Olaf Scholz"], "orgs": ["NATO"], "locations": ["Paris"], "events": ["NATO summit"], "markets": [], "products": []}}
  - "OpenAI launches GPT-5 amid AI scrutiny push from EU"
    → {{"persons": [], "orgs": ["OpenAI"], "locations": [], "events": [], "markets": [], "products": ["GPT-5"]}}
  - "CAC 40 drops as ECB raises rates amid stagflation fears"
    → {{"persons": [], "orgs": ["European Central Bank"], "locations": [], "events": [], "markets": ["CAC 40"], "products": []}}
  - "Trump and Vance defend new tariff policy at White House briefing"
    → {{"persons": ["Donald Trump", "JD Vance"], "orgs": [], "locations": ["White House"], "events": [], "markets": [], "products": []}}
  - "Apple unveils iPhone 18 at WWDC"
    → {{"persons": [], "orgs": ["Apple Inc."], "locations": [], "events": ["WWDC"], "markets": [], "products": ["iPhone 18"]}}
"""


_SYSTEM_SINGLE = _RULES + "\n\nReturn ONLY the raw JSON object for the article. No markdown, no code fences."

_SYSTEM_BATCH = _RULES + """

You will receive a JSON object with an "articles" array. Each article has an "id", "title_normalized", optional "summary_full", optional "lang", and optional "source_country".
Apply ALL the rules above to each article INDEPENDENTLY.
Return ONLY a JSON object of the form: {"results": {"0": {extracted_object}, "1": {extracted_object}, ...}}
The keys are the article ids (as strings) from the input. The values are full extracted JSON objects with every field described above.
You MUST include exactly one entry per input article id. No markdown, no code fences."""


def _canonicalize_entity(s: str) -> str:
    """Strip accents, collapse whitespace, trim common trailing punctuation."""
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(".,;:'\"")
    return s


def _build_keep_org(source_name: str | None):
    """Return a `keep_org(s)` predicate used by `validate_entities` to drop
    the article's own publisher and any bare country/region name."""
    source_lower = _canonicalize_entity(source_name or "").lower() if source_name else ""

    def keep_org(s: str) -> bool:
        lo = _canonicalize_entity(s).lower()
        if source_lower and lo == source_lower:
            return False
        if lo in _BARE_COUNTRY_NAMES:
            return False
        return True

    return keep_org


def _parse_result(result: Any, article: dict) -> dict:
    """Convert raw LLM JSON for Call B into the standardized extracted dict.

    Returns a dict with the 5 extractor-owned fields ready to UPDATE
    on the article row (`category`, `keywords`, `countries`, `entities`,
    `article_type`). Validation drops invalid values silently with a
    Sentry warning per drop (see src.validation).
    """
    article_id = article.get("id")
    if not isinstance(result, dict):
        if result is not None:
            record_validation_warning(
                "extract", "result", article_id,
                f"non-dict response ({type(result).__name__})"
            )
        result = {}

    categories   = validate_categories(result.get("categories"),    "extract", article_id)
    keywords     = validate_keywords(result.get("keywords"),        "extract", article_id)
    countries    = validate_countries(result.get("countries"),      "extract", article_id)
    article_type = validate_article_type(result.get("article_type"), "extract", article_id)
    entities     = validate_entities(
        result.get("entities"),
        "extract",
        article_id,
        keep_org=_build_keep_org(article.get("source_name")),
    )
    # Apply entity-string canonicalization (accents stripped, whitespace
    # collapsed) — validate_entities only strips empties / dedupes.
    entities = {
        k: [_canonicalize_entity(v) for v in vs if _canonicalize_entity(v)]
        for k, vs in entities.items()
    }

    return {
        "category":     json.dumps(categories) if categories else None,
        "keywords":     json.dumps(keywords),
        "countries":    json.dumps(countries),
        "entities":     json.dumps(entities),
        "article_type": article_type,
    }


def _clean_article_for_prompt(article: dict) -> str:
    """Build the user-content string for a single article."""
    parts = [f'Title: {article["title_normalized"]}']
    if article.get("summary_full"):
        parts.append(f'Summary: {article["summary_full"][:4000]}')
    elif article.get("summary_normalized"):
        parts.append(f'Summary: {article["summary_normalized"]}')
    if article.get("lang"):
        parts.append(f'Source language: {article["lang"]}')
    if article.get("source_country"):
        parts.append(f'Source country: {article["source_country"]} (disambiguator)')
    if article.get("source_name"):
        parts.append(f'Publisher: {article["source_name"]} (do not put in entities.orgs unless the article is about the publisher itself)')
    return "\n".join(parts)


def _extract_one(article: dict, client: OpenAI) -> dict:
    """Extract metadata for a single article via one LLM call.

    Used as a fallback when batch parsing drops an article, and exposed
    for renormalize.py to run extraction one-off on a re-normalized row.
    """
    user_text = _clean_article_for_prompt(article)
    t0 = time.perf_counter()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _SYSTEM_SINGLE},
            {"role": "user",   "content": user_text},
        ],
        response_format={"type": "json_object"},
        max_completion_tokens=600,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    try:
        result = json.loads(response.choices[0].message.content)
    except Exception:
        result = {}
    out = _parse_result(result, article)
    out["input_tokens"]  = response.usage.prompt_tokens
    out["output_tokens"] = response.usage.completion_tokens
    out["duration_ms"]   = duration_ms
    out["_call_kind"]    = "single"
    return out


def _extract_batch(articles: list[dict], client: OpenAI) -> list[dict]:
    """Extract metadata for up to N articles in a single LLM call."""
    if not articles:
        return []

    items: list[dict] = []
    for i, a in enumerate(articles):
        item = {"id": str(i), "title_normalized": a["title_normalized"]}
        if a.get("summary_full"):
            item["summary_full"] = a["summary_full"][:4000]
        elif a.get("summary_normalized"):
            item["summary_full"] = a["summary_normalized"]
        if a.get("lang"):
            item["lang"] = a["lang"]
        if a.get("source_country"):
            item["source_country"] = a["source_country"]
        if a.get("source_name"):
            item["publisher"] = a["source_name"]
        items.append(item)

    user_content = json.dumps({"articles": items}, ensure_ascii=False)

    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM_BATCH},
                {"role": "user",   "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=600 * len(articles) + 400,
        )
        batch_duration_ms = int((time.perf_counter() - t0) * 1000)
        parsed = json.loads(response.choices[0].message.content)
        results_map = parsed.get("results") if isinstance(parsed, dict) else None
        if not isinstance(results_map, dict):
            raise ValueError("missing 'results' object in batch response")
        tokens_in  = response.usage.prompt_tokens
        tokens_out = response.usage.completion_tokens
    except Exception as e:
        print(f"  [extract batch error: {e}; falling back to single calls]")
        return [_extract_one(a, client) for a in articles]

    outputs: list[dict | None] = [None] * len(articles)
    missing: list[int]         = []
    for i, a in enumerate(articles):
        r = results_map.get(str(i))
        if not isinstance(r, dict):
            missing.append(i)
        else:
            outputs[i] = _parse_result(r, a)

    if missing:
        print(f"  [extract batch: {len(missing)}/{len(articles)} entries missing, retrying individually]")
        for i in missing:
            outputs[i] = _extract_one(articles[i], client)

    per_in  = tokens_in  // max(1, len(articles))
    per_out = tokens_out // max(1, len(articles))
    for out in outputs:
        if out is not None and "input_tokens" not in out:
            out["input_tokens"]  = per_in
            out["output_tokens"] = per_out
            out["duration_ms"]   = batch_duration_ms
            out["_call_kind"]    = "batch"

    return outputs  # type: ignore[return-value]


def extract_pending(
    conn,
    client: OpenAI,
    limit: int | None = None,
) -> dict:
    """Run Call B on every article that finished Call A but never finished
    Call B (= `title_normalized IS NOT NULL AND entities IS NULL`).

    Writes `category`, `keywords`, `countries`, `entities`, `article_type`
    in a single UPDATE per article.
    """
    query = """
        SELECT a.id, a.title, a.title_normalized, a.summary, a.summary_normalized,
               a.summary_full, a.lang,
               s.country AS source_country, s.name AS source_name
          FROM items a
          LEFT JOIN sources s ON s.id = a.source_id
         WHERE a.title_normalized IS NOT NULL
           AND a.entities IS NULL
           AND a.archive_seed = FALSE
         ORDER BY a.fetched_at DESC
    """
    if limit is not None:
        query += f" LIMIT {int(limit)}"

    cur = conn.cursor()
    cur.execute(query)
    rows = cur.fetchall()
    if not rows:
        return {"extracted": 0, "cost": 0.0}

    n_total = len(rows)
    articles = [
        {
            "id":                 r[0],
            "title":              r[1],
            "title_normalized":   r[2],
            "summary":            r[3] or "",
            "summary_normalized": r[4],
            "summary_full":       r[5],
            "lang":               r[6],
            "source_country":     r[7],
            "source_name":        r[8],
        }
        for r in rows
    ]

    batch_size  = 10
    parallelism = 8

    # Same parallelization pattern as normalize_pending: workers do the
    # LLM call only, the main thread does the DB UPDATEs serially (the
    # psycopg2 connection isn't thread-safe).
    batches = [
        articles[i:i + batch_size]
        for i in range(0, n_total, batch_size)
    ]
    n_batches = len(batches)
    print(f"  Extracting metadata for {n_total} article(s) — {n_batches} "
          f"batch(es) of ≤{batch_size}, {parallelism}-way parallel...")

    pad        = len(str(n_total))
    total_in   = total_out = 0
    processed  = 0
    batch_done = 0
    log_every  = max(1, n_batches // 20)

    with ThreadPoolExecutor(max_workers=parallelism,
                            thread_name_prefix="extract") as pool:
        future_to_batch = {
            pool.submit(_extract_batch, batch, client): batch
            for batch in batches
        }

        for fut in as_completed(future_to_batch):
            batch = future_to_batch[fut]
            try:
                results = fut.result()
            except Exception as e:
                print(f"  [extract] batch error: {type(e).__name__}: {e} "
                      f"— skipping {len(batch)} article(s)")
                continue

            for art, r in zip(batch, results):
                cur.execute(
                    """UPDATE items SET
                       category     = %s,
                       keywords     = %s,
                       countries    = %s,
                       entities     = %s,
                       article_type = %s
                       WHERE id = %s""",
                    (
                        r["category"],
                        r["keywords"],
                        r["countries"],
                        r["entities"],
                        r["article_type"],
                        art["id"],
                    ),
                )
                total_in  += r["input_tokens"]
                total_out += r["output_tokens"]
                log_llm_call(
                    conn, model=MODEL, step="extract",
                    purpose=r.get("_call_kind", "batch"),
                    item_id=art["id"],
                    input_tokens=r.get("input_tokens", 0),
                    output_tokens=r.get("output_tokens", 0),
                    duration_ms=r.get("duration_ms"),
                )
                processed += 1
            batch_done += 1
            conn.commit()

            if batch_done % log_every == 0 or batch_done == n_batches:
                cost_so_far = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
                last_title  = (batch[-1]["title_normalized"] or "")[:60]
                print(f"  [batch {batch_done:>{len(str(n_batches))}}/{n_batches}] "
                      f"{processed:>{pad}}/{n_total} done · {last_title}  "
                      f"(${cost_so_far:.4f})")

    cost = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
    return {"extracted": processed, "cost": cost}
