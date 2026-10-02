"""
The editorial layer of a story, kept in one call.

A story of two articles or more carries four pieces of English text:

  label      a short descriptor of what the cluster is about;
  synthesis  one wire-service sentence with the story's key facts;
  origin     one sentence reporting the seed article — the first entry of
             the timeline, written once;
  timeline   short notes, each naming what one article added.

All four are maintained by one LLM call per story and per worker pass,
made when the story has articles it has not read yet
(`story_items.analyzed_for_updates_at IS NULL`). The call sees the
story's current text, a sample of all its titles, and the new articles
only — so its cost follows what arrives, not the size of the story — and
returns the text as it should now read, plus a note for each new article
that adds something.

A story of one article gets nothing: its reader sees the article itself.
Its pending row waits, and is read with the next article to join.

The text is English. When the label or synthesis changes, its
translations are cleared so the translators write them again; an
unchanged text keeps them.

A story whose call fails is tried again on the next passes, up to
MAX_ATTEMPTS in the life of the worker process; after that its pending
articles are marked read without notes rather than retried forever.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field

from openai import OpenAI

from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import TEXT_MODEL
from src.notifications import fan_out_followers

MODEL = TEXT_MODEL

# Titles shown for the label's coverage rule, sampled across the story's
# life and sources when it has more — see `sample_titles`.
MAX_TITLES = 20
# New articles read per call. A story that received more waits for the
# next pass for the rest, oldest first.
MAX_NEW_ARTICLES = 10
# Stories in flight at once. Each call is independent.
PARALLELISM = 8
# Failed calls tolerated per story before its pending articles are given up.
MAX_ATTEMPTS = 3
# Reasoning tokens count against this cap; the visible output is ~200.
MAX_COMPLETION_TOKENS = 4000

_failures: dict[int, int] = {}


# ── Prompt ──────────────────────────────────────────────────────────────────
# Fixed and first, so OpenAI's prompt cache serves it on every call after
# the first.
_SYSTEM = """You maintain the editorial layer of one news story — a cluster of articles about the same subject — for a newsroom reader who scans many stories quickly. Everything you write is in English, whatever the source language; translate concepts and proper nouns naturally (OTAN -> NATO, UE -> EU), strip accents.

You receive:
- CURRENT: the story's label, synthesis, origin and timeline as they stand. Empty for a new story.
- TITLES: titles from across the whole story, for the label.
- SEED: the story's first article, present only when the story has no origin yet.
- NEW ARTICLES: the articles that joined since the story was last written, each with an id, oldest first.

You return the four parts below. Use only facts present in the input.

# 1. Label

A short descriptor that lets a reader decide in 2 seconds whether to open the story. It describes the CONTENT of the cluster — it is not a news headline. No action verbs ("seeks", "slams"), no punchy numbers as the hook, no "X: Y" splits, no trailing punctuation, no filler ("news", "topics"). At most 7 words, a natural noun phrase leading with the most distinctive entity, place or theme.

First fill `themes`: 1 to 4 candidate themes in TITLES, each with how many titles fit it. If one theme fits 60% of the titles or more, make the label specific to it ("Iran ceasefire fragile truce", "Nvidia Q1 record earnings", "ECB inflation rate decision"). Otherwise the cluster is heterogeneous: write an umbrella label naming what the themes share, never generic ("Enterprise AI adoption and economic impact", "Big tech antitrust scrutiny worldwide"). Coverage matters more than punchiness: a label anchored on an angle only 2 of 8 articles cover makes readers skip a story they would have opened.

If CURRENT has a label and it still fits the rule, return it unchanged, word for word.

# 2. Synthesis

ONE sentence (15-30 words) packing the story's key facts, as the story now stands. Prefer facts the label does not already carry — named actors, a material number, the why. Wire-service style: dense, factual, active voice; no hedging ("reportedly"), no meta-language ("multiple articles say"), no source attribution, no markdown.

If CURRENT has a synthesis and the new articles change nothing material, return it unchanged, word for word. If the input is too thin to summarise, return: Insufficient detail to summarize.

# 3. Origin

When SEED is present: ONE sentence (12-25 words) reporting the seed article's news directly, leading with the principal actor and the action. Use only facts in the seed; if it is thin, stay sober rather than invent context. Same style rules as the synthesis.
When SEED is absent: null.

# 4. Timeline notes

For each NEW ARTICLE, decide what it adds that a reader of the origin, the timeline and the notes you already wrote in this answer could not know. When it adds something, write ONE note (5-15 words, at most 20) with that article's id. When it adds nothing, write no note for it — that is a normal outcome.

A new fact is a number, date, named person, organisation or place, a specific event, decision or consequence. A different stakeholder reacting, a different time horizon, a different market affected all count. Synonyms and re-attributions of a known fact do not; nor do framing, analyst opinion or restatement.

Style: telegraphic editor's note — drop needless articles, fragments and colon-led notes are fine, a semicolon may join 2-3 closely related facts. Active verbs; no "according to", no "the article reports". The note must read on its own but must not restate what is above it. Vocabulary follows the story's domain.

<example>
CURRENT:
  label: (none)
  synthesis: (none)
  origin: (none)
  timeline: (empty)

TITLES:
- EU blocks funds for key Chinese solar energy parts
- Commission blocks EU funding for Huawei solar tech
- Renewable energy: EU stops financing Chinese inverters

SEED:
  title: EU blocks funds for key Chinese solar energy parts
  summary: The EU has blocked funds for key Chinese solar energy components, citing security concerns. The decision forms part of a broader crackdown on sensitive China-made imports into Europe.

NEW ARTICLES:
- id: 2
  title: Commission blocks EU funding for Huawei solar tech
  summary: The European Commission decided to block EU funding related to Huawei solar technology, citing a risk that foreign actors could disrupt the EU's critical infrastructure.
- id: 3
  title: Renewable energy: EU stops financing Chinese inverters
  summary: The European Commission wants to restrict access to the European inverter market for Huawei and Sungrow to protect critical energy infrastructure.

OUTPUT:
  themes: EU funding ban on Chinese solar parts (3)
  label: EU funding ban on Chinese solar inverters
  synthesis: Brussels suspended EU subsidies for renewable projects using inverters from Huawei, Sungrow and other Chinese suppliers, citing risks of foreign-triggered grid disruption.
  origin: The EU blocked funding for renewable projects using key Chinese solar components, citing security concerns in a broader crackdown on sensitive China-made imports.
  notes:
    2: Huawei specifically targeted; cites foreign-actor risk to critical infrastructure.
    3: Restriction extended to Sungrow.
</example>

<example>
CURRENT:
  label: Bullish acquisition of Equiniti
  synthesis: Crypto exchange Bullish agreed to buy transfer agent Equiniti for $4.2 billion, extending its tokenization push into capital markets.
  origin: Crypto exchange Bullish agreed to acquire transfer agent Equiniti for $4.2 billion, extending its tokenization push into traditional capital-markets plumbing.
  timeline: (empty)

TITLES:
- Crypto exchange Bullish strikes $4.2 billion deal for transfer agent in tokenization push
- Crypto exchange Bullish to buy Equiniti in $4.2 billion deal

NEW ARTICLES:
- id: 7
  title: Crypto exchange Bullish to buy Equiniti in $4.2 billion deal
  summary: Crypto exchange Bullish plans to acquire Equiniti in a $4.2 billion deal, according to the report.

OUTPUT:
  themes: Bullish buys Equiniti (2)
  label: Bullish acquisition of Equiniti
  synthesis: Crypto exchange Bullish agreed to buy transfer agent Equiniti for $4.2 billion, extending its tokenization push into capital markets.
  origin: null
  notes: (none — article 7 restates the known deal)
</example>"""


_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "story_state",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                # Before the label on purpose: fields are generated in
                # order, so the coverage count is made before the label
                # is committed to. Discarded after parsing.
                "themes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name":   {"type": "string"},
                            "fits_n": {"type": "integer"},
                        },
                        "required": ["name", "fits_n"],
                        "additionalProperties": False,
                    },
                },
                "label":     {"type": "string"},
                "synthesis": {"type": "string"},
                "origin":    {"type": ["string", "null"]},
                "notes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "article": {"type": "string"},
                            "note":    {"type": "string"},
                        },
                        "required": ["article", "note"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["themes", "label", "synthesis", "origin", "notes"],
            "additionalProperties": False,
        },
    },
}


# ── Inputs and outputs ──────────────────────────────────────────────────────
@dataclass
class Article:
    id:      int
    title:   str
    summary: str = ""
    lang:    str = ""
    source:  object = None   # diversity key for sampling: first delivering monitor


@dataclass
class StoryInput:
    story_id:  int
    label:     str | None
    synthesis: str | None
    origin:    str | None
    timeline:  list[str]
    titles:    list[Article]          # the whole story, chronological
    seed:      Article | None         # set when the story has no origin yet
    new:       list[Article]          # pending, oldest first, seed excluded
    pending_ids: list[int] = field(default_factory=list)  # every row this call settles


@dataclass
class StoryState:
    label:     str
    synthesis: str
    origin:    str | None
    notes:     dict[int, str]         # article id → note


def sample_titles(articles: list[Article], max_titles: int = MAX_TITLES,
                  n_buckets: int = 4) -> list[Article]:
    """Up to `max_titles` articles spread across the story's life and its
    sources: the chronological list is cut into `n_buckets`, and each
    bucket contributes its share, distinct sources first.

    Head-and-tail sampling would crowd the prompt with the seed and the
    latest arrivals and drop the middle, where a story drifts.
    """
    if len(articles) <= max_titles:
        return list(articles)
    per_bucket, extra = divmod(max_titles, n_buckets)
    size = len(articles) / n_buckets
    buckets = [articles[int(i * size):int((i + 1) * size)] for i in range(n_buckets)]

    sampled: list[Article] = []
    for i, bucket in enumerate(buckets):
        quota = per_bucket + (1 if i < extra else 0)
        picked, seen = [], set()
        for a in bucket:
            if a.source not in seen:
                picked.append(a)
                seen.add(a.source)
                if len(picked) == quota:
                    break
        for a in bucket:
            if len(picked) == quota:
                break
            if a not in picked:
                picked.append(a)
        sampled.extend(picked)
    return sampled


def build_message(story: StoryInput) -> str:
    """The user message: the story as it stands, then what is new."""
    def article(a: Article, *, with_id: bool) -> list[str]:
        lang = f"[{a.lang}] " if a.lang else ""
        head = f"- id: {a.id}\n  title: {lang}{a.title}" if with_id else f"  title: {lang}{a.title}"
        return [head] + ([f"  summary: {a.summary}"] if a.summary else [])

    timeline = "\n".join(f"    - {t}" for t in story.timeline) or "    (empty)"
    lines = [
        "CURRENT:",
        f"  label: {story.label or '(none)'}",
        f"  synthesis: {story.synthesis or '(none)'}",
        f"  origin: {story.origin or '(none)'}",
        f"  timeline:\n{timeline}",
        "",
        "TITLES:",
        *(f"- {a.title}" for a in sample_titles(story.titles)),
    ]
    if story.seed is not None:
        lines += ["", "SEED:", *article(story.seed, with_id=False)]
    lines += ["", "NEW ARTICLES:"]
    for a in story.new:
        lines += article(a, with_id=True)
    if not story.new:
        lines.append("(none)")
    return "\n".join(lines)


def parse_response(raw: str, story: StoryInput) -> StoryState:
    """Read the model's answer. Raises ValueError when it is unusable, so
    the story is tried again rather than written half-empty."""
    data = json.loads(raw)

    def text(value) -> str:
        return (value or "").replace("\x00", "").strip()

    label, synthesis = text(data.get("label")), text(data.get("synthesis"))
    if not label or not synthesis:
        raise ValueError("empty label or synthesis")

    origin = None
    if story.seed is not None:
        origin = text(data.get("origin"))
        if not origin:
            raise ValueError("no origin for a story that needs one")

    # A note is kept only for an article of this call, once: an id the
    # model invented or repeated would attach text to the wrong article.
    new_ids = {a.id for a in story.new}
    notes: dict[int, str] = {}
    for entry in data.get("notes") or []:
        try:
            article_id = int(str(entry.get("article")).strip())
        except (TypeError, ValueError):
            continue
        note = text(entry.get("note"))
        if note and article_id in new_ids and article_id not in notes:
            notes[article_id] = note
    return StoryState(label, synthesis, origin, notes)


# ── Database ────────────────────────────────────────────────────────────────
def _pending_stories(cur) -> list[int]:
    """Active stories of two articles or more with an article not yet read."""
    cur.execute(
        """SELECT s.id FROM stories s
            WHERE s.status = 'active' AND s.n_items >= 2
              AND EXISTS (SELECT 1 FROM story_items si
                           WHERE si.story_id = s.id
                             AND si.analyzed_for_updates_at IS NULL)
            ORDER BY s.n_items DESC"""
    )
    return [r[0] for r in cur.fetchall()]


def _load_story(cur, story_id: int) -> StoryInput | None:
    cur.execute(
        "SELECT label, synthesis_normalized, origin_normalized FROM stories WHERE id = %s",
        (story_id,),
    )
    label, synthesis, origin = cur.fetchone()

    cur.execute(
        """SELECT a.id, a.title_normalized, a.summary_normalized, a.lang,
                  si.analyzed_for_updates_at IS NULL,
                  (SELECT mi.monitor_id FROM monitor_items mi
                    WHERE mi.item_id = a.id ORDER BY mi.fetched_at LIMIT 1)
             FROM story_items si
             JOIN items a ON a.id = si.item_id
            WHERE si.story_id = %s
            ORDER BY COALESCE(a.published_at, a.fetched_at), a.id""",
        (story_id,),
    )
    articles, pending, unusable = [], [], []
    for item_id, title, summary, lang, is_pending, monitor_id in cur.fetchall():
        title = (title or "").strip()
        if not title:
            # Nothing to read: settled with the others, never sent.
            if is_pending:
                unusable.append(item_id)
            continue
        a = Article(item_id, title, (summary or "").strip(), (lang or "").lower(), monitor_id)
        articles.append(a)
        if is_pending:
            pending.append(a)
    if not articles:
        cur.execute(
            """UPDATE story_items SET analyzed_for_updates_at = now()
                WHERE story_id = %s AND item_id = ANY(%s)""",
            (story_id, unusable),
        )
        return None

    origin = (origin or "").strip() or None
    seed = None if origin else articles[0]
    new = [a for a in pending if seed is None or a.id != seed.id][:MAX_NEW_ARTICLES]
    settled = [a.id for a in new] + unusable
    if seed is not None and seed in pending:
        settled.append(seed.id)

    cur.execute(
        "SELECT content FROM story_updates WHERE story_id = %s ORDER BY added_at",
        (story_id,),
    )
    timeline = [r[0] for r in cur.fetchall() if r[0]]
    return StoryInput(story_id, label, synthesis, origin, timeline,
                      articles, seed, new, settled)


def _save(cur, story: StoryInput, state: StoryState) -> list[tuple[int, int, str]]:
    """Write the story's text and notes. Returns the notes written, as
    (update id, article id, note), for the followers to be told."""
    cur.execute(
        """UPDATE stories SET
               label = %(label)s, label_lang = 'en',
               label_translations = CASE WHEN label IS DISTINCT FROM %(label)s
                                         THEN '{}'::jsonb ELSE label_translations END,
               last_labeled_at = CASE WHEN label IS DISTINCT FROM %(label)s
                                      THEN now() ELSE last_labeled_at END,
               synthesis_translations = CASE WHEN synthesis_normalized IS DISTINCT FROM %(synthesis)s
                                             THEN '{}'::jsonb ELSE synthesis_translations END,
               synthesis_at = CASE WHEN synthesis_normalized IS DISTINCT FROM %(synthesis)s
                                   THEN now() ELSE synthesis_at END,
               synthesis_normalized = %(synthesis)s,
               origin_normalized = COALESCE(%(origin)s, origin_normalized),
               origin_at = CASE WHEN %(origin)s IS NULL THEN origin_at ELSE now() END
           WHERE id = %(id)s""",
        {"id": story.story_id, "label": state.label,
         "synthesis": state.synthesis, "origin": state.origin},
    )
    written = []
    for a in story.new:
        note = state.notes.get(a.id)
        if note:
            cur.execute(
                """INSERT INTO story_updates (story_id, content, source_item_id)
                   VALUES (%s, %s, %s) RETURNING id""",
                (story.story_id, note, a.id),
            )
            written.append((cur.fetchone()[0], a.id, note))
    _mark_read(cur, story)
    return written


def _mark_read(cur, story: StoryInput) -> None:
    cur.execute(
        """UPDATE story_items SET analyzed_for_updates_at = now()
            WHERE story_id = %s AND item_id = ANY(%s)""",
        (story.story_id, story.pending_ids),
    )


def _notify_followers(conn, story: StoryInput, label: str,
                      written: list[tuple[int, int, str]]) -> None:
    for update_id, article_id, note in written:
        try:
            fan_out_followers(conn, story.story_id, "story_update", {
                "story_id":    story.story_id,
                "story_title": label,
                "kind":        "new_update",
                "update_id":   update_id,
                "update_text": note,
                "article_id":  article_id,
            })
        except Exception as e:
            # Best-effort: a failed notification never loses the note.
            print(f"  [story_state] notification failed story={story.story_id}: "
                  f"{type(e).__name__}: {e}", flush=True)


# ── The step ────────────────────────────────────────────────────────────────
def _call(story: StoryInput, client: OpenAI) -> tuple[StoryState, int, int, int]:
    """One call for one story. Touches no database."""
    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": _SYSTEM},
            {"role": "user",   "content": build_message(story)},
        ],
        response_format=_SCHEMA,
        max_completion_tokens=MAX_COMPLETION_TOKENS,
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    state = parse_response(resp.choices[0].message.content or "", story)
    return state, resp.usage.prompt_tokens, resp.usage.completion_tokens, duration_ms


def refresh_story_states(conn, client: OpenAI) -> dict:
    """Bring every story with unread articles up to date.

    Inputs are loaded and results written on `conn`, in this thread; only
    the LLM calls run in parallel.
    """
    cur = conn.cursor()
    stories = []
    for story in filter(None, (_load_story(cur, sid) for sid in _pending_stories(cur))):
        if story.new or story.seed is not None:
            stories.append(story)
        else:
            _mark_read(cur, story)     # only unreadable rows were pending
    conn.commit()
    if not stories:
        return {"stories": 0, "notes": 0, "failed": 0, "cost": 0.0}

    print(f"  [story_state] {len(stories)} stor(ies), "
          f"{sum(len(s.new) for s in stories)} new article(s)", flush=True)
    written_total = failed = tokens_in = tokens_out = 0

    with ThreadPoolExecutor(max_workers=PARALLELISM) as pool:
        futures = {pool.submit(_call, s, client): s for s in stories}
        for future in as_completed(futures):
            story = futures[future]
            try:
                state, t_in, t_out, duration_ms = future.result()
            except Exception as e:
                failed += 1
                log_llm_call(conn, model=MODEL, step="story_state", story_id=story.story_id,
                             success=False, error=f"{type(e).__name__}: {e}"[:500])
                _give_up_after_repeated_failures(cur, story, e)
                conn.commit()
                continue

            tokens_in += t_in
            tokens_out += t_out
            log_llm_call(conn, model=MODEL, step="story_state", story_id=story.story_id,
                         input_tokens=t_in, output_tokens=t_out, duration_ms=duration_ms)
            written = _save(cur, story, state)
            conn.commit()
            _failures.pop(story.story_id, None)
            written_total += len(written)
            _notify_followers(conn, story, state.label, written)
            conn.commit()

    cost = estimate_cost(MODEL, input_tokens=tokens_in, output_tokens=tokens_out)
    return {"stories": len(stories), "notes": written_total, "failed": failed, "cost": cost}


def _give_up_after_repeated_failures(cur, story: StoryInput, error: Exception) -> None:
    attempts = _failures.get(story.story_id, 0) + 1
    print(f"  [story_state] story {story.story_id} failed ({attempts}/{MAX_ATTEMPTS}): "
          f"{type(error).__name__}: {error}", flush=True)
    if attempts < MAX_ATTEMPTS:
        _failures[story.story_id] = attempts
        return
    # The articles are marked read without notes; the story is written
    # again with the next article to join it.
    _failures.pop(story.story_id, None)
    _mark_read(cur, story)
