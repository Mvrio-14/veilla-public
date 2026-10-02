"""
Article normalization — the first LLM call (Call A).

Translates the source title + summary to clean English and produces a
faithful **full-length** English summary alongside the existing
50-word brief. Detects the source language. That's it — the topic
metadata (categories, keywords, countries, entities, article_type)
lives in `src/extractor.py` (Call B).

Why split:
  - a single LLM call doing everything suffers from long-prompt drift,
    which silently hurts entity quality and topic alignment;
  - separating concerns lets each call have a tighter system prompt;
  - Call B reads `title_normalized + summary_full + lang` from Call A,
    so even the model has cleaner input than the raw scraped HTML.

DB write contract:
  - this module writes ONLY: `title`, `title_normalized`,
    `summary_normalized`, `summary_full`, `lang`. (and strips NUL bytes
    from `title`).
  - `category`, `keywords`, `countries`, `entities`, `article_type`
    are left untouched here — they're filled later by the extractor
    step on the same article row.

Pending detection — split-aware:
  - normalize_pending: `title_normalized IS NULL`. New articles only.
  - extract_pending (in extractor.py): `title_normalized IS NOT NULL
    AND entities IS NULL`. Articles that finished Call A but never
    finished Call B (= every new article + any old article where Call
    B failed transiently).
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from openai import OpenAI

from src.ingest import clean_title_attribution
from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL
from src.taxonomy import CATEGORIES  # noqa: F401  (re-exported for legacy callers)
from src.validation import validate_lang

MODEL         = TEXT_MODEL


_RULES = """You are a news editor. For each news article, produce a JSON object with the following fields.

GENERAL RULES:
- Use clean English.
- Remove accents from all outputs (e.g. Cedric, Raphael).
- Be factual, concise, and consistent.
- Use only the provided content.
- Return ONLY the JSON object. No markdown, no explanations.
- For non-Latin scripts (Chinese, Japanese, Korean, Arabic, etc.) in the source: TRANSLATE the meaning into English. Do not transliterate proper nouns into Latin script unless they are widely known by their English spelling (e.g. "Xi Jinping" — yes; obscure provincial officials — keep the Pinyin / Romaji form the source provides).
- If the input title or summary is empty or otherwise unusable, emit the title field as best you can and return summary_normalized = "" and summary_full = "" rather than inventing content.

---

"title_normalized": the article title translated to English.
  - Use sentence case: capitalize only the first word and proper nouns.
  - Translate international organizations (OTAN->NATO, ONU->UN, UE->EU).
  - For local organizations, keep original name but add English description in parentheses.
  - Remove accents from proper nouns (Cedric, Raphael).
  - Strip any trailing source attribution such as " - Source" or " | Source" (e.g. " - Le Monde", " | BBC News").
  - If already in English, apply sentence case and strip any source suffix only.
  - For roundup/digest/recap articles, strip format labels such as "Roundup", "Market Talk", "Digest", "Morning Brief", "Daily Wrap", "Weekly", "Evening Wrap" from the title. Preserve only the specific topic. E.g. "Healthcare Market Roundup" → "Healthcare market"; "Financial Services: Market Talk" → "Financial services"; "Tech Daily Digest" → "Technology news".

"summary_normalized": 2-3 sentence factual summary in English, max 50 words.
  - Journalistic style: who, what, where, key context. Include key named entities.
  - Semantically dense. Remove accents. Empty string if no usable content.

"summary_full": a faithful, complete English rendering of the article's body.
  - Translate every sentence of the source summary/content into clean English while preserving all the facts, figures, names, dates and quotes present in the input.
  - Do NOT abridge, paraphrase aggressively, or skip content — this is the "full reading" version of the article, not a brief.
  - Do NOT add information that isn't in the input — no extrapolation, no extra context the source did not provide.
  - Preserve the original paragraph structure when possible; use blank lines between paragraphs.
  - If the source body is empty or unusable, return an empty string "".
  - If the source body is already in English, lightly clean it (sentence case for the lead, accent stripping, remove publisher attribution) but preserve all content.
  - This field will only be displayed when the user opts into "full translation" mode in the UI — it is not seen by default.

"lang": the ISO 639-1 two-letter code (lowercase) of the article's source language.
  - Based on the original title and summary, NOT the source country.
  - Examples: "fr", "en", "es", "de", "it", "pt", "zh", "ja", "ar", "ru".
  - Always required.
"""

_SYSTEM_SINGLE = _RULES + "\n\nReturn ONLY the raw JSON object for the article. No markdown, no code fences."

_SYSTEM_BATCH = _RULES + """

You will receive a JSON object with an "articles" array. Each article has an "id", "title", optional "summary", and optional "source_country".
Apply ALL the rules above to each article INDEPENDENTLY.
Return ONLY a JSON object of the form: {"results": {"0": {normalized_object}, "1": {normalized_object}, ...}}
The keys are the article ids (as strings) from the input. The values are full normalized JSON objects with every field described above.
You MUST include exactly one entry per input article id. No markdown, no code fences."""


def _parse_result(result: dict, raw_title: str, article: dict) -> dict:
    """Convert the raw LLM JSON for Call A into the standardized dict.

    Returns a stripped dict with ONLY the Call A fields (title, title_normalized,
    summary_normalized, summary_full, lang). The extractor (Call B) is
    responsible for the topic-classification fields and writes them in a
    separate UPDATE.
    """
    if not isinstance(result, dict):
        result = {}

    raw_title_normalized = result.get("title_normalized")
    title_normalized     = (raw_title_normalized or raw_title or "").replace("\x00", "")

    summary_normalized = (result.get("summary_normalized") or "").replace("\x00", "")
    summary_full       = (result.get("summary_full") or "").replace("\x00", "")

    lang = validate_lang(result.get("lang"), "normalize", article.get("id"))

    return {
        "title":              raw_title,
        "title_normalized":   title_normalized,
        "summary_normalized": summary_normalized,
        "summary_full":       summary_full,
        "lang":               lang,
    }


def _clean_article_for_prompt(article: dict) -> tuple[str, str]:
    """Return (cleaned_title, user_content_string) for a single article's prompt."""
    source_name = article.get("source_name")
    raw_title   = clean_title_attribution(article["title"], source_name)
    parts = [f'Title: {raw_title}']
    if article.get("summary"):
        raw_summary = clean_title_attribution(article["summary"][:2400], source_name)
        parts.append(f'Summary: {raw_summary}')
    if article.get("source_country"):
        parts.append(f'Source country: {article["source_country"]} (use to disambiguate geographic references)')
    return raw_title, "\n".join(parts)


def _normalize_one(article: dict, client: OpenAI) -> dict:
    """Normalize a single article via one LLM call. Used by renormalize.py."""
    raw_title, user_text = _clean_article_for_prompt(article)
    t0 = time.perf_counter()
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _SYSTEM_SINGLE},
            {"role": "user",   "content": user_text},
        ],
        response_format={"type": "json_object"},
        # Bumped from 600 → 1200 to give summary_full room to land
        # without truncation on long articles (50-word brief alone took
        # ~150 tokens; full summary can take 600-800 on a substantive
        # piece). Safety margin keeps us under any rate-limit issue.
        max_completion_tokens=1200,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    try:
        result = json.loads(response.choices[0].message.content)
    except Exception:
        result = {}
    out = _parse_result(result, raw_title, article)
    out["input_tokens"]  = response.usage.prompt_tokens
    out["output_tokens"] = response.usage.completion_tokens
    out["duration_ms"]   = duration_ms
    out["_call_kind"]    = "single"
    return out


def _normalize_batch(articles: list[dict], client: OpenAI) -> list[dict]:
    """
    Normalize up to N articles in a single LLM call. Returns a list aligned with
    input order. On parse error or missing entries, falls back to single-article
    calls for the affected articles.
    """
    if not articles:
        return []

    raw_titles: list[str] = []
    items: list[dict]     = []
    for i, a in enumerate(articles):
        raw_title, _ = _clean_article_for_prompt(a)
        raw_titles.append(raw_title)
        item = {"id": str(i), "title": raw_title}
        if a.get("summary"):
            raw_summary = clean_title_attribution(a["summary"][:2400], a.get("source_name"))
            item["summary"] = raw_summary
        if a.get("source_country"):
            item["source_country"] = a["source_country"]
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
            # 1200 per article: summary_full is much longer than the brief,
            # so we need a bigger budget per slot. The +400 buffer covers
            # JSON scaffolding overhead for the batch wrapper.
            max_completion_tokens=1200 * len(articles) + 400,
        )
        batch_duration_ms = int((time.perf_counter() - t0) * 1000)
        parsed = json.loads(response.choices[0].message.content)
        results_map = parsed.get("results") if isinstance(parsed, dict) else None
        if not isinstance(results_map, dict):
            raise ValueError("missing 'results' object in batch response")
        tokens_in  = response.usage.prompt_tokens
        tokens_out = response.usage.completion_tokens
    except Exception as e:
        print(f"  [batch error: {e}; falling back to single calls]")
        return [_normalize_one(a, client) for a in articles]

    outputs: list[dict | None] = [None] * len(articles)
    missing: list[int]         = []
    for i, a in enumerate(articles):
        r = results_map.get(str(i))
        if not isinstance(r, dict):
            missing.append(i)
        else:
            outputs[i] = _parse_result(r, raw_titles[i], a)

    if missing:
        print(f"  [batch: {len(missing)}/{len(articles)} entries missing, retrying individually]")
        for i in missing:
            outputs[i] = _normalize_one(articles[i], client)

    per_in  = tokens_in  // max(1, len(articles))
    per_out = tokens_out // max(1, len(articles))
    for out in outputs:
        if out is not None and "input_tokens" not in out:
            out["input_tokens"]  = per_in
            out["output_tokens"] = per_out
            # Batch wall-clock applies to every article in the batch.
            # When summed it over-counts (N article-rows × 1 call duration),
            # so latency queries should filter `purpose='single'` for
            # true per-call wall-clock, or `purpose='batch'` for the
            # batched call's duration shared across N articles.
            out["duration_ms"]   = batch_duration_ms
            out["_call_kind"]    = "batch"

    return outputs  # type: ignore[return-value]


def normalize_pending(
    conn,
    client: OpenAI,
    limit: int | None = None,
    max_age_hours: int | None = 24,
) -> dict:
    """
    Normalize articles where title_normalized IS NULL (Call A only).

    Topic-extraction fields (category, keywords, countries, entities,
    article_type) are NOT written here — the extractor step downstream
    handles them based on `title_normalized + summary_full` produced by
    this call. Splitting keeps both prompts tight and lets the
    extractor read clean English instead of raw HTML.

    Args:
        conn:          open DB connection
        client:        OpenAI client
        limit:         max articles to process (None = all pending)
        max_age_hours: skip articles whose published_at is older than this cutoff.
                       Articles with NULL published_at are always kept.
                       None disables the time filter.
    """
    params: list = []
    query = """
        SELECT a.id, a.title, a.summary, s.country as source_country, s.name as source_name
        FROM items a
        LEFT JOIN sources s ON s.id = a.source_id
        WHERE a.title_normalized IS NULL
          AND a.title IS NOT NULL
          AND a.archive_seed = FALSE
    """
    if max_age_hours is not None:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=int(max_age_hours))).isoformat(timespec="seconds")
        # Effective date for filtering: real pubdate when the feed provided
        # one, else the moment we first saw the article. Article is in window
        # if either is recent enough.
        query += " AND COALESCE(a.published_at, a.fetched_at) >= %s"
        params.append(cutoff)

    query += " ORDER BY fetched_at DESC"
    if limit is not None:
        query += f" LIMIT {int(limit)}"

    cur = conn.cursor()
    cur.execute(query, params)
    rows = cur.fetchall()
    if not rows:
        return {"normalized": 0, "cost": 0.0}

    n_total  = len(rows)
    articles = [
        {"id": r[0], "title": r[1], "summary": r[2] or "",
         "source_country": r[3], "source_name": r[4]}
        for r in rows
    ]

    batch_size  = 10
    parallelism = 8

    # Build batches up front so workers can pick them up concurrently.
    # The previous sequential loop was the wall-clock bottleneck at scale
    # (N batches × ~2-3s/batch). Parallelizing the LLM calls cuts pass
    # time ~4× without changing prompt or schema. The DB writes stay
    # serialized on the main thread (psycopg2 conn isn't thread-safe).
    batches = [
        articles[i:i + batch_size]
        for i in range(0, n_total, batch_size)
    ]
    n_batches = len(batches)
    print(f"  Normalizing {n_total} article(s) — {n_batches} batch(es) of "
          f"≤{batch_size}, {parallelism}-way parallel...")

    pad        = len(str(n_total))
    total_in   = total_out = 0
    processed  = 0
    batch_done = 0
    log_every  = max(1, n_batches // 20)

    with ThreadPoolExecutor(max_workers=parallelism,
                            thread_name_prefix="normalize") as pool:
        future_to_batch = {
            pool.submit(_normalize_batch, batch, client): batch
            for batch in batches
        }

        for fut in as_completed(future_to_batch):
            batch = future_to_batch[fut]
            try:
                results = fut.result()
            except Exception as e:
                print(f"  [normalize] batch error: {type(e).__name__}: {e} "
                      f"— skipping {len(batch)} article(s)")
                continue

            for art, r in zip(batch, results):
                # Postgres TEXT rejects NUL (0x00) bytes that some malformed RSS
                # sources let slip into titles. Strip those known-bad chars only;
                # any other failure must surface so we can investigate it.
                params = tuple(
                    v.replace("\x00", "") if isinstance(v, str) else v
                    for v in (
                        r["title"],
                        r["title_normalized"],
                        r["summary_normalized"],
                        r["summary_full"],
                        r["lang"],
                        art["id"],
                    )
                )
                cur.execute(
                    """UPDATE items SET
                       title = %s,
                       title_normalized = %s,
                       summary_normalized = %s,
                       summary_full = %s,
                       lang = COALESCE(%s, lang)
                       WHERE id = %s""",
                    params,
                )
                total_in  += r["input_tokens"]
                total_out += r["output_tokens"]
                log_llm_call(
                    conn, model=MODEL, step="normalize",
                    purpose=r.get("_call_kind", "batch"),
                    item_id=art["id"],
                    input_tokens=r.get("input_tokens", 0),
                    output_tokens=r.get("output_tokens", 0),
                    duration_ms=r.get("duration_ms"),
                )
                processed += 1
            batch_done += 1
            # Commit per batch — same crash-safety guarantee as before.
            conn.commit()

            if batch_done % log_every == 0 or batch_done == n_batches:
                cost_so_far = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
                last_title  = (results[-1]["title_normalized"][:60]
                               if results else "")
                print(f"  [batch {batch_done:>{len(str(n_batches))}}/{n_batches}] "
                      f"{processed:>{pad}}/{n_total} done · {last_title}  "
                      f"(${cost_so_far:.4f})")

    cost = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
    return {"normalized": processed, "cost": cost}
