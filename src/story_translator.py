"""
Story texts, in every reader language.

`story_state` writes each story's label, synthesis, origin and timeline
notes once, in English. This step translates what a story is missing in
a language — all of it in one call — and caches it on the story
(`label_translations`, `synthesis_translations`, `origin_translations`)
and on each note (`story_updates.translations`), where the loaders read
it. One translation per text and language, shared by every reader of
that language.

`story_state` clears a label's or synthesis's translations when it
changes the text, so a changed text is translated again on the next
pass; an origin and a note never change.

Only stories the Watch shows as clusters are translated — active, two
articles or more, news within the window — and only into the languages
of readers who follow a monitor that delivered one of their articles.
Saved and filed stories keep the translations they had, and fall back to
English otherwise.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from openai import OpenAI

from src.languages import language_name, translation_targets
from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL

MODEL = TEXT_MODEL

WINDOW_HOURS = 48
PARALLELISM = 8
# Reasoning tokens count against this cap; the visible output is ~300.
MAX_COMPLETION_TOKENS = 4000

_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "story_translation",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "label":     {"type": "string"},
                "synthesis": {"type": "string"},
                "origin":    {"type": "string"},
                "updates": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id":   {"type": "string"},
                            "text": {"type": "string"},
                        },
                        "required": ["id", "text"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["label", "synthesis", "origin", "updates"],
            "additionalProperties": False,
        },
    },
}


def _system_prompt(lang: str) -> str:
    name = language_name(lang)
    return f"""Translate the texts of one news story into {name}, as a native {name} news journalist would write them. Only the fields present in the input are to be translated; return an empty string for a field that is absent, and one entry per update, with its id.

- label: a short descriptor of the story (at most 7 words). Keep it concise; sentence case, capitalising only the first word and proper nouns.
- synthesis, origin: one factual sentence each. Faithful and neutral: keep every fact, number and name; add or remove nothing; one sentence, no bullets.
- updates: telegraphic timeline notes, each saying only what was new at the time. Keep their length and style. They may point back to earlier entries ("of those", "the meeting") — keep those references as they are, do not spell out what they refer to.

Everywhere: natural {name}; proper nouns in their standard {name} form, accents kept (Mélenchon, Brötchen); no commentary, attribution or framing of your own."""


@dataclass
class Missing:
    story_id:  int
    lang:      str
    label:     str | None = None
    synthesis: str | None = None
    origin:    str | None = None
    updates:   dict[int, str] = field(default_factory=dict)   # update id → English


def _missing(cur, lang: str) -> list[Missing]:
    """What each story shown in the window lacks in `lang`."""
    cur.execute(
        f"""SELECT s.id,
                   CASE WHEN s.label_lang IS DISTINCT FROM %(lang)s
                         AND NOT s.label_translations ? %(lang)s THEN s.label END,
                   CASE WHEN NOT s.synthesis_translations ? %(lang)s THEN s.synthesis_normalized END,
                   CASE WHEN NOT s.origin_translations ? %(lang)s THEN s.origin_normalized END
              FROM stories s
             WHERE s.status = 'active' AND s.n_items >= 2
               AND s.latest_pub > now() - interval '{WINDOW_HOURS} hours'
               AND EXISTS (SELECT 1
                             FROM story_items si
                             JOIN monitor_items mi ON mi.item_id = si.item_id
                             JOIN subscriptions sub ON sub.monitor_id = mi.monitor_id
                             JOIN users u ON u.id = sub.user_id
                            WHERE si.story_id = s.id
                              AND u.active AND u.output_lang = %(lang)s)""",
        {"lang": lang},
    )
    stories = {
        sid: Missing(sid, lang, *(t.strip() if t and t.strip() else None for t in texts))
        for sid, *texts in cur.fetchall()
    }
    if stories:
        cur.execute(
            """SELECT story_id, id, content FROM story_updates
                WHERE story_id = ANY(%(ids)s) AND NOT translations ? %(lang)s
                ORDER BY added_at""",
            {"ids": list(stories), "lang": lang},
        )
        for story_id, update_id, content in cur.fetchall():
            if content and content.strip():
                stories[story_id].updates[update_id] = content.strip()
    return [m for m in stories.values()
            if m.label or m.synthesis or m.origin or m.updates]


def build_message(m: Missing) -> str:
    payload = {k: v for k, v in (("label", m.label), ("synthesis", m.synthesis),
                                 ("origin", m.origin)) if v}
    if m.updates:
        payload["updates"] = [{"id": str(i), "text": t} for i, t in m.updates.items()]
    return json.dumps(payload, ensure_ascii=False)


def parse_response(raw: str, m: Missing) -> Missing:
    """The translations of what was asked for; anything else is ignored."""
    data = json.loads(raw)

    def text(value) -> str | None:
        return (value or "").replace("\x00", "").strip() or None

    updates = {}
    for entry in data.get("updates") or []:
        try:
            update_id = int(str(entry.get("id")))
        except (TypeError, ValueError):
            continue
        if update_id in m.updates and text(entry.get("text")):
            updates[update_id] = text(entry.get("text"))
    return Missing(
        m.story_id, m.lang,
        label=text(data.get("label")) if m.label else None,
        synthesis=text(data.get("synthesis")) if m.synthesis else None,
        origin=text(data.get("origin")) if m.origin else None,
        updates=updates,
    )


def _translate(m: Missing, client: OpenAI):
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _system_prompt(m.lang)},
            {"role": "user",   "content": build_message(m)},
        ],
        response_format=_SCHEMA,
        max_completion_tokens=MAX_COMPLETION_TOKENS,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    return (parse_response(resp.choices[0].message.content or "{}", m),
            resp.usage.prompt_tokens, resp.usage.completion_tokens, duration_ms)


def _save(cur, t: Missing) -> int:
    """Merge the translations into their maps. Returns how many texts."""
    for column, value in (("label_translations", t.label),
                          ("synthesis_translations", t.synthesis),
                          ("origin_translations", t.origin)):
        if value:
            cur.execute(
                f"UPDATE stories SET {column} = {column} || jsonb_build_object(%s, %s) WHERE id = %s",
                (t.lang, value, t.story_id),
            )
    for update_id, value in t.updates.items():
        cur.execute(
            """UPDATE story_updates SET translations = translations || jsonb_build_object(%s, %s)
                WHERE id = %s AND story_id = %s""",
            (t.lang, value, update_id, t.story_id),
        )
    return sum(1 for v in (t.label, t.synthesis, t.origin) if v) + len(t.updates)


def refresh_story_translations(conn, client: OpenAI) -> dict:
    """Translate what the stories shown lack, in every reader language.
    Loads and writes on `conn`, in this thread; only the calls run in
    parallel."""
    cur = conn.cursor()
    work = [m for lang in translation_targets(conn) for m in _missing(cur, lang)]
    translated = tokens_in = tokens_out = 0
    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
        futures = {pool.submit(_translate, m, client): m for m in work}
        for future in as_completed(futures):
            m = futures[future]
            try:
                result, t_in, t_out, duration_ms = future.result()
            except Exception as e:
                print(f"  [story_translator] story {m.story_id} {m.lang} failed: "
                      f"{type(e).__name__}: {e}", flush=True)
                log_llm_call(conn, model=MODEL, step="story_translate", purpose=m.lang,
                             story_id=m.story_id, success=False,
                             error=f"{type(e).__name__}: {e}"[:500])
                conn.commit()
                continue
            tokens_in += t_in
            tokens_out += t_out
            log_llm_call(conn, model=MODEL, step="story_translate", purpose=m.lang,
                         story_id=m.story_id, input_tokens=t_in, output_tokens=t_out,
                         duration_ms=duration_ms)
            translated += _save(cur, result)
            conn.commit()

    cost = estimate_cost(MODEL, input_tokens=tokens_in, output_tokens=tokens_out)
    return {"stories": len(work), "translated": translated, "cost": cost}
