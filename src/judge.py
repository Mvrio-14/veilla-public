"""
Watchers judge the stories of their reader's monitors.

A watcher is a standing request a reader wrote ("the decisions that
decarbonise European industry, not the op-eds"). On each worker pass,
every active watcher reads the stories that received articles it has not
seen yet, within its scope, and decides for each whether to keep it:
a verdict, one sentence of reason, and optionally the passage it rests
on. Nothing is sent anywhere yet; the verdicts are shown in Signal.

## What one judgment sees

A story as it stands, and what is new to this watcher:

  - the story's label and synthesis (English, from story_state), or the
    article itself for a story of one article, which has neither;
  - the articles new to the watcher, newest first, at most
    MAX_NEW_ARTICLES — every pending one is settled by the judgment, the
    rest are only not shown;
  - the reason of its last "kept" on this story, when there is one, so a
    story it already kept is kept again only for something new.

That bounds a judgment's cost whatever the length of the story. With it
come the reader's context and the watcher's request.

## Which articles

An article is in a watcher's scope when one of the watcher's monitors
delivered it, after the watcher was created: a watcher watches from the
moment it exists, and never judges what came before. It is new to the
watcher when no judgment of the watcher on its story lists it, and only
articles of the last WINDOW_HOURS are looked at.

## Live first: budget and skips

Signal is for what is happening now, so the newest stories always go
first, and nothing is judged hours late. A watcher judges at most
DAILY_BUDGET stories in 24 hours, newest first. A story the budget could
not reach is recorded as skipped once its newest article is older than
STALE_HOURS, rather than judged late, and the reader sees it
(src/signal.py). A story over budget but still fresh waits for the next
pass.

A judgment that fails is not written, so its articles are tried again on
the next passes, up to MAX_ATTEMPTS in the life of the worker process;
after that the story waits for its next article, or a restart.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from openai import OpenAI

from src.languages import language_name
from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL

MODEL = TEXT_MODEL

WINDOW_HOURS = 24
DAILY_BUDGET = 200
STALE_HOURS = 6
MAX_NEW_ARTICLES = 10
PARALLELISM = 8
# Failed calls tolerated per watcher and story before giving up on them.
MAX_ATTEMPTS = 3
# Reasoning tokens count against this cap; the visible output is ~60.
MAX_COMPLETION_TOKENS = 2000

# (watcher id, story id, newest pending article) → failed calls. Keyed on
# the newest article so a story that receives another is tried afresh.
#
# Kept in memory on purpose. A failed call writes nothing, so the articles
# stay pending and the next pass retries them for free; this counter only
# stops a story that fails every time from costing a call on every pass.
# Losing it on a restart costs at most MAX_ATTEMPTS calls per such story,
# which is cheaper than a table, a migration and a cleanup job.
_failures: dict[tuple[int, int, int], int] = {}


# ── Prompt ──────────────────────────────────────────────────────────────────
# Fixed and first, so OpenAI's prompt cache serves it on every call.
_SYSTEM = """You screen news stories for one reader. The reader wrote a REQUEST saying which stories they want passed on, and a CONTEXT saying who they are. You decide for one story whether it answers the request.

You receive:
- CONTEXT: who the reader is and what counts as news for them. May be empty.
- REQUEST: what to keep, in the reader's words. It may exclude things; exclusions count as much as inclusions.
- STORY: the story's label and synthesis as it now stands.
- NEW ARTICLES: the articles of the story you have not seen yet, newest first.
- ALREADY KEPT: present when you kept this story before, with the reason you gave then.

Decide:
- "kept" when the story, with its new articles, is what the request asks for, for this reader.
- "dropped" otherwise. When unsure, drop: a reader forgives a missed story more easily than noise.
- When ALREADY KEPT is present, keep again only if the new articles bring a material new fact the request cares about (a decision, a figure, a date, a named actor). Coverage of what was already kept is "dropped", with a reason saying nothing new.

Reason: ONE sentence, at most 25 words, in {language}, naming the concrete fact that decided — not a paraphrase of the request. No "the article", no "this story".

Excerpt: a short passage (at most 30 words) copied word for word from the title or summary of one NEW ARTICLE, that the verdict rests on. An empty string when no single passage carries it."""


def _system(lang: str) -> str:
    return _SYSTEM.format(language=language_name(lang))


_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "judgment",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "verdict": {"type": "string", "enum": ["kept", "dropped"]},
                "reason":  {"type": "string"},
                "excerpt": {"type": "string"},
            },
            "required": ["verdict", "reason", "excerpt"],
            "additionalProperties": False,
        },
    },
}


# ── Inputs and outputs ──────────────────────────────────────────────────────
@dataclass
class Article:
    id:      int
    title:   str
    summary: str
    source:  str
    url:     str


@dataclass
class Watcher:
    id:         int
    user_id:    str
    request:    str
    context:    str
    lang:       str
    monitors:   list[int]
    created_at: datetime


@dataclass
class Pending:
    """A story with articles new to one watcher."""
    story_id: int
    item_ids: list[int]              # newest first
    newest:   datetime               # when the newest of them arrived


@dataclass
class Moment:
    """One story, as one watcher is about to judge it."""
    watcher:      Watcher
    story_id:     int
    label:        str
    synthesis:    str
    articles:     list[Article]          # shown, newest first
    item_ids:     list[int]              # every article the judgment settles
    already_kept: str | None = None
    input:        dict = field(default_factory=dict)


@dataclass
class Judgment:
    verdict: str
    reason:  str
    excerpt: str | None


def build_message(m: Moment) -> str:
    lines = [
        "CONTEXT:",
        m.watcher.context.strip() or "(empty)",
        "",
        "REQUEST:",
        m.watcher.request.strip(),
        "",
        "STORY:",
        f"  label: {m.label}",
        f"  synthesis: {m.synthesis or '(none)'}",
        "",
        "NEW ARTICLES:",
    ]
    for a in m.articles:
        lines.append(f"- title: {a.title}")
        if a.summary:
            lines.append(f"  summary: {a.summary}")
        if a.source:
            lines.append(f"  source: {a.source}")
    if m.already_kept:
        lines += ["", "ALREADY KEPT:", m.already_kept]
    return "\n".join(lines)


def parse_response(raw: str, m: Moment) -> Judgment:
    """Read the model's answer. Raises ValueError when it is unusable, so
    the articles are judged again rather than settled without a reason."""
    data = json.loads(raw)
    verdict = data.get("verdict")
    reason = (data.get("reason") or "").replace("\x00", "").strip()
    if verdict not in ("kept", "dropped") or not reason:
        raise ValueError(f"unusable judgment: {data!r}")

    # An excerpt is kept only if it is found in what the watcher was shown:
    # a quotation the articles do not contain would mislead the reader.
    excerpt = (data.get("excerpt") or "").strip().strip('"').strip()
    shown = " ".join(f"{a.title} {a.summary}" for a in m.articles).casefold()
    if not excerpt or excerpt.casefold() not in shown:
        excerpt = None
    return Judgment(verdict, reason, excerpt)


def plan(pending: list[Pending], budget: int,
         now: datetime) -> tuple[list[Pending], list[Pending]]:
    """Which pending stories to judge on this pass, and which to skip.

    `pending` is newest first. The budget takes the newest; a story it
    does not reach is skipped once stale, and waits otherwise.
    """
    budget = max(budget, 0)
    stale = now - timedelta(hours=STALE_HOURS)
    return pending[:budget], [p for p in pending[budget:] if p.newest < stale]


# ── Database ────────────────────────────────────────────────────────────────
def _active_watchers(cur) -> list[Watcher]:
    """Active watchers of active readers, each with the monitors it reads:
    its own selection among what the reader follows, or everything the
    reader follows when it has no selection."""
    cur.execute(
        """SELECT w.id, w.user_id, w.request, u.context, u.output_lang, w.created_at,
                  ARRAY(SELECT s.monitor_id FROM subscriptions s
                         WHERE s.user_id = w.user_id
                           AND (NOT EXISTS (SELECT 1 FROM watcher_monitors wm
                                             WHERE wm.watcher_id = w.id)
                                OR EXISTS (SELECT 1 FROM watcher_monitors wm
                                            WHERE wm.watcher_id = w.id
                                              AND wm.monitor_id = s.monitor_id)))
             FROM watchers w
             JOIN users u ON u.id = w.user_id
            WHERE w.status = 'active' AND u.active
            ORDER BY w.id"""
    )
    return [
        Watcher(id=r[0], user_id=str(r[1]), request=r[2], context=r[3] or "",
                lang=r[4] or "en", monitors=list(r[6]), created_at=r[5])
        for r in cur.fetchall()
    ]


def _budget_left(cur, watcher_id: int) -> int:
    """Judgments the watcher may still make in the rolling day."""
    cur.execute(
        """SELECT count(*) FROM judgments
            WHERE watcher_id = %s AND verdict <> 'skipped'
              AND created_at > now() - interval '1 day'""",
        (watcher_id,),
    )
    return DAILY_BUDGET - cur.fetchone()[0]


def _pending(cur, watcher: Watcher) -> list[Pending]:
    """Stories with articles new to the watcher, most recently fed first."""
    if not watcher.monitors:
        return []
    cur.execute(
        """SELECT si.story_id,
                   array_agg(i.id ORDER BY COALESCE(i.published_at, i.fetched_at) DESC, i.id DESC),
                   max(i.fetched_at)
              FROM items i
              JOIN story_items si ON si.item_id = i.id
             WHERE i.fetched_at > now() - make_interval(hours => %(window)s)
               AND i.fetched_at >= %(created)s
               AND NOT i.archive_seed
               AND TRIM(COALESCE(i.title_normalized, '')) <> ''
               AND EXISTS (SELECT 1 FROM monitor_items mi
                            WHERE mi.item_id = i.id AND mi.monitor_id = ANY(%(monitors)s))
               AND NOT EXISTS (SELECT 1 FROM judgments j
                                WHERE j.watcher_id = %(watcher)s
                                  AND j.story_id = si.story_id
                                  AND i.id = ANY(j.item_ids))
             GROUP BY si.story_id
             ORDER BY max(i.fetched_at) DESC""",
        {"monitors": watcher.monitors, "watcher": watcher.id, "created": watcher.created_at,
         "window": WINDOW_HOURS},
    )
    return [Pending(r[0], list(r[1]), r[2]) for r in cur.fetchall()]


def _load_moment(cur, watcher: Watcher, story_id: int, item_ids: list[int]) -> Moment | None:
    shown_ids = item_ids[:MAX_NEW_ARTICLES]
    cur.execute(
        """SELECT i.id, i.title_normalized, COALESCE(i.summary_normalized, ''),
                  COALESCE(src.name, ''), i.url
             FROM items i
             LEFT JOIN sources src ON src.id = i.source_id
            WHERE i.id = ANY(%s)""",
        (shown_ids,),
    )
    by_id = {r[0]: Article(r[0], r[1].strip(), r[2].strip(), r[3], r[4]) for r in cur.fetchall()}
    articles = [by_id[i] for i in shown_ids if i in by_id]
    if not articles:
        return None

    cur.execute(
        "SELECT label, synthesis_normalized, n_items FROM stories WHERE id = %s",
        (story_id,),
    )
    row = cur.fetchone()
    if row is None:
        return None
    label, synthesis, n_items = row
    # A story of one article has no text of its own: the article is the story.
    if n_items < 2 or not (label or "").strip():
        label, synthesis = articles[0].title, articles[0].summary

    cur.execute(
        """SELECT reason FROM judgments
            WHERE watcher_id = %s AND story_id = %s AND verdict = 'kept'
            ORDER BY created_at DESC LIMIT 1""",
        (watcher.id, story_id),
    )
    kept = cur.fetchone()

    m = Moment(watcher, story_id, label.strip(), (synthesis or "").strip(), articles,
               item_ids, kept[0] if kept else None)
    m.input = {
        "label": m.label,
        "synthesis": m.synthesis,
        "articles": [{"title": a.title, "source": a.source, "url": a.url} for a in articles],
        "already_kept": m.already_kept,
    }
    return m


def _save(cur, m: Moment, j: Judgment, pass_at: datetime, tokens_in: int, tokens_out: int) -> None:
    cur.execute(
        """INSERT INTO judgments (watcher_id, story_id, pass_at, item_ids, verdict, reason,
                                  excerpt, input, model, input_tokens, output_tokens)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (m.watcher.id, m.story_id, pass_at, m.item_ids, j.verdict, j.reason, j.excerpt,
         json.dumps(m.input, ensure_ascii=False), MODEL, tokens_in, tokens_out),
    )


def _skip(cur, watcher: Watcher, skipped: list[Pending], pass_at: datetime) -> None:
    """Record the stories the budget could not reach in time: no call,
    no reason, the articles they covered, and enough to list them."""
    shown = {i for p in skipped for i in p.item_ids[:MAX_NEW_ARTICLES]}
    cur.execute(
        """SELECT i.id, i.title_normalized, COALESCE(src.name, ''), i.url
             FROM items i LEFT JOIN sources src ON src.id = i.source_id
            WHERE i.id = ANY(%s)""",
        (list(shown),),
    )
    articles = {r[0]: {"title": r[1], "source": r[2], "url": r[3]} for r in cur.fetchall()}
    for p in skipped:
        shown_articles = [articles[i] for i in p.item_ids[:MAX_NEW_ARTICLES] if i in articles]
        label = shown_articles[0]["title"] if shown_articles else ""
        cur.execute(
            """INSERT INTO judgments (watcher_id, story_id, pass_at, item_ids, verdict,
                                      reason, input, model)
               VALUES (%s, %s, %s, %s, 'skipped', 'budget', %s, '')""",
            (watcher.id, p.story_id, pass_at, p.item_ids,
             json.dumps({"label": label, "synthesis": "", "articles": shown_articles,
                         "already_kept": None}, ensure_ascii=False)),
        )


# ── The step ────────────────────────────────────────────────────────────────
def _call(m: Moment, client: OpenAI) -> tuple[Judgment, int, int, int]:
    """One call for one moment. Touches no database."""
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _system(m.watcher.lang)},
            {"role": "user",   "content": build_message(m)},
        ],
        response_format=_SCHEMA,
        max_completion_tokens=MAX_COMPLETION_TOKENS,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    judgment = parse_response(resp.choices[0].message.content or "", m)
    return judgment, resp.usage.prompt_tokens, resp.usage.completion_tokens, duration_ms


def judge_pending(conn, client: OpenAI, pass_at: datetime) -> dict:
    """Judge every story with articles new to an active watcher.

    Inputs are loaded and results written on `conn`, in this thread; only
    the LLM calls run in parallel.
    """
    cur = conn.cursor()
    moments: list[Moment] = []
    skipped = 0
    for watcher in _active_watchers(cur):
        pending = [p for p in _pending(cur, watcher)
                   if _failures.get((watcher.id, p.story_id, p.item_ids[0]), 0) < MAX_ATTEMPTS]
        to_judge, to_skip = plan(pending, _budget_left(cur, watcher.id), pass_at)
        for p in to_judge:
            m = _load_moment(cur, watcher, p.story_id, p.item_ids)
            if m is not None:
                moments.append(m)
        if to_skip:
            _skip(cur, watcher, to_skip, pass_at)
            skipped += len(to_skip)
    conn.commit()
    if not moments:
        return {"judged": 0, "kept": 0, "skipped": skipped, "failed": 0, "cost": 0.0}

    print(f"  [judge] {len(moments)} stor(ies) to judge", flush=True)
    judged = kept = failed = tokens_in = tokens_out = 0
    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
        futures = {pool.submit(_call, m, client): m for m in moments}
        for future in as_completed(futures):
            m = futures[future]
            try:
                j, t_in, t_out, duration_ms = future.result()
            except Exception as e:
                failed += 1
                key = (m.watcher.id, m.story_id, m.item_ids[0])
                _failures[key] = _failures.get(key, 0) + 1
                print(f"  [judge] watcher {m.watcher.id} story {m.story_id} failed: "
                      f"{type(e).__name__}: {e}", flush=True)
                log_llm_call(conn, model=MODEL, step="judge", user_id=m.watcher.user_id,
                             story_id=m.story_id, success=False,
                             error=f"{type(e).__name__}: {e}"[:500])
                conn.commit()
                continue
            tokens_in += t_in
            tokens_out += t_out
            log_llm_call(conn, model=MODEL, step="judge", user_id=m.watcher.user_id,
                         story_id=m.story_id, input_tokens=t_in, output_tokens=t_out,
                         duration_ms=duration_ms)
            _save(cur, m, j, pass_at, t_in, t_out)
            conn.commit()
            judged += 1
            kept += j.verdict == "kept"

    cost = estimate_cost(MODEL, input_tokens=tokens_in, output_tokens=tokens_out)
    return {"judged": judged, "kept": kept, "skipped": skipped, "failed": failed, "cost": cost}
