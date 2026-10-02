"""
Article titles and summaries, in every reader language.

The normaliser writes each article's title and summary in English
(`title_normalized`, `summary_normalized`). This step translates both, in
one call, into each language Veilla has readers in, and caches them on
the item (`title_translations`, `summary_translations`, keyed by
language), where the loaders read them. One translation per article and
language, shared by every reader of that language.

An article is translated into a language only when a reader of that
language can see it — a monitor that delivered it is followed by an
active user reading in that language — and only when it has a story,
since the Watch shows nothing else. It is not translated into its own
source language, whose readers see the original, nor into English, whose
readers see the normaliser's text.

The Watch holds an article back until its title is readable in the
reader's language; see `loaders.watch.load_visible_articles`.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from openai import OpenAI

from src.languages import language_name, translation_targets
from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL

MODEL = TEXT_MODEL

# The Watch never reaches further back.
WINDOW_HOURS = 48
# Articles per call: a title and a 50-word summary each.
BATCH_SIZE = 10
PARALLELISM = 8
# Reasoning tokens count against this cap; the visible output is ~1,000.
MAX_COMPLETION_TOKENS = 8000

_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "article_translations",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "articles": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id":      {"type": "string"},
                            "title":   {"type": "string"},
                            "summary": {"type": "string"},
                        },
                        "required": ["id", "title", "summary"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["articles"],
            "additionalProperties": False,
        },
    },
}


def _system_prompt(lang: str) -> str:
    name = language_name(lang)
    return (
        f"Translate the title and summary of each news article into {name}, "
        f"as a native {name} news journalist would write them — natural, idiomatic, accurate.\n"
        "- Title: sentence case, capitalising only the first word and proper nouns.\n"
        "- Summary: the same level of detail, natural prose, no bullets or formatting added. "
        "An empty summary stays empty.\n"
        "- Preserve proper nouns; transliterate non-Latin scripts by standard conventions.\n"
        "- Add nothing absent from the original.\n"
        "Return one entry per input article, with its id."
    )


def _pending(cur, lang: str) -> list[dict]:
    cur.execute(
        f"""SELECT a.id, a.title_normalized, COALESCE(a.summary_normalized, '')
              FROM items a
             WHERE a.fetched_at > now() - interval '{WINDOW_HOURS} hours'
               AND NOT a.archive_seed
               AND TRIM(COALESCE(a.title_normalized, '')) <> ''
               AND a.lang IS DISTINCT FROM %(lang)s
               AND NOT COALESCE(a.title_translations ? %(lang)s, FALSE)
               AND EXISTS (SELECT 1 FROM story_items si WHERE si.item_id = a.id)
               AND EXISTS (SELECT 1
                             FROM monitor_items mi
                             JOIN subscriptions s ON s.monitor_id = mi.monitor_id
                             JOIN users u ON u.id = s.user_id
                            WHERE mi.item_id = a.id
                              AND u.active AND u.output_lang = %(lang)s)
             ORDER BY a.fetched_at DESC""",
        {"lang": lang},
    )
    return [{"id": r[0], "title": r[1], "summary": r[2]} for r in cur.fetchall()]


def _translate(batch: list[dict], lang: str, client: OpenAI):
    """One call for one batch. Touches no database. Returns
    ({article id: (title, summary)}, input tokens, output tokens, ms)."""
    payload = [{"id": str(a["id"]), "title": a["title"], "summary": a["summary"]} for a in batch]
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _system_prompt(lang)},
            {"role": "user",   "content": json.dumps({"articles": payload}, ensure_ascii=False)},
        ],
        response_format=_SCHEMA,
        max_completion_tokens=MAX_COMPLETION_TOKENS,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    wanted = {str(a["id"]): a for a in batch}
    out: dict[int, tuple[str, str]] = {}
    for entry in json.loads(resp.choices[0].message.content or "{}").get("articles") or []:
        article = wanted.get(str(entry.get("id")))
        title = (entry.get("title") or "").replace("\x00", "").strip()
        if article is None or not title:
            continue
        summary = (entry.get("summary") or "").replace("\x00", "").strip()
        out[article["id"]] = (title, summary if article["summary"] else "")
    return out, resp.usage.prompt_tokens, resp.usage.completion_tokens, duration_ms


def refresh_article_translations(conn, client: OpenAI) -> dict:
    """Translate what readers can see and cannot read yet. Loads and
    writes on `conn`, in this thread; only the calls run in parallel."""
    cur = conn.cursor()
    translated = tokens_in = tokens_out = 0
    for lang in translation_targets(conn):
        pending = _pending(cur, lang)
        if not pending:
            continue
        batches = [pending[i:i + BATCH_SIZE] for i in range(0, len(pending), BATCH_SIZE)]
        with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
            futures = {pool.submit(_translate, b, lang, client): b for b in batches}
            for future in as_completed(futures):
                try:
                    results, t_in, t_out, duration_ms = future.result()
                except Exception as e:
                    print(f"  [article_translator] {lang} batch failed: "
                          f"{type(e).__name__}: {e}", flush=True)
                    log_llm_call(conn, model=MODEL, step="article_translate", purpose=lang,
                                 success=False, error=f"{type(e).__name__}: {e}"[:500])
                    conn.commit()
                    continue
                tokens_in += t_in
                tokens_out += t_out
                log_llm_call(conn, model=MODEL, step="article_translate", purpose=lang,
                             input_tokens=t_in, output_tokens=t_out, duration_ms=duration_ms)
                for item_id, (title, summary) in results.items():
                    # Merged into the maps rather than rewritten, so two
                    # languages never overwrite each other.
                    cur.execute(
                        """UPDATE items
                              SET title_translations = COALESCE(title_translations, '{}') || jsonb_build_object(%(lang)s, %(title)s),
                                  summary_translations = CASE WHEN %(summary)s = '' THEN summary_translations
                                      ELSE summary_translations || jsonb_build_object(%(lang)s, %(summary)s) END
                            WHERE id = %(id)s""",
                        {"lang": lang, "title": title, "summary": summary, "id": item_id},
                    )
                translated += len(results)
                conn.commit()

    cost = estimate_cost(MODEL, input_tokens=tokens_in, output_tokens=tokens_out)
    return {"translated": translated, "cost": cost}
