"""
LLM disambiguator — picks the right Wikidata candidate when there's
real ambiguity ("Apple" the company vs the fruit vs the record label).

Architectural place: this is the *fallback* path. The resolver only
calls into here when:

  1. The local cache (entities.aliases) had no hit for this surface, AND
  2. Wikidata returned ≥ 2 plausible candidates AND
  3. Top-1 vs top-2 don't have a clear gap (the resolver decides what
     "clear gap" means).

When called, the LLM gets:
  - The article context (title + summary, condensed)
  - The surface form as it appeared
  - The 3-5 candidates with their EN label + description
  - The kind the extractor thought this mention was

And it returns either a single QID or null (= none of the candidates
match the context).

# Why a separate module, not inline in entity_resolver.py

Two reasons:
  - The prompt + parsing logic is self-contained and verbose. Keeping
    it here makes the resolver code readable as an algorithm.
  - It's the only file that knows about the OpenAI client in the
    resolution pipeline — the rest of entity_resolver.py can be tested
    against a Wikidata mock without an LLM.

# Cost discipline

The model is the pipeline's text model (src/llm_models.py). Each call
is ~300-500 input tokens and emits ~10-30 output tokens via a tool-call
response. It fires only when Wikidata's top candidate is not clear-cut:
about 200 calls a day in September 2026, some $0.30 a week.

We DON'T retry on transient errors here — if the LLM hiccups, the
resolver downgrades the mention to `unlinked` instead of waiting. The
next pass picks up the article anyway through the pending sentinel.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass

from openai import OpenAI

from src.llm_models import TEXT_MODEL
from src.wikidata_client import WikidataCandidate

_log = logging.getLogger(__name__)


MODEL = TEXT_MODEL
# Sized so the LLM has room for qid + confidence + a one-sentence
# reasoning. ~200 tokens covers all output safely.
_MAX_OUTPUT_TOKENS = 200


@dataclass(frozen=True)
class DisambiguationResult:
    """Outcome of a single disambiguation call."""
    qid:        str | None    # the Q-id chosen, or None if no candidate matched
    confidence: float            # 0..1, the LLM's stated confidence
    reasoning:  str              # brief justification — for audit + debug
    input_tokens:  int
    output_tokens: int
    duration_ms:   int | None = None   # None when no LLM call was made
                                          # (single-candidate shortcut + cache shortcuts)
    model:         str | None = None   # None when no LLM call was made


# Confidence floor below which we mark unlinked instead of trusting
# the LLM pick. 0.6 strikes a balance: above this the LLM is committing
# to a clear answer; below it's flagging real uncertainty that's worth
# surfacing as unlinked (curatable in admin UI) rather than silently
# guessing.
CONFIDENCE_FLOOR = 0.6


_SYSTEM = """\
You disambiguate entity mentions in news articles by picking the right Wikidata entity from a small candidate list.

Inputs you receive:
- The mention's surface form as it appeared in the article (e.g. "Vance").
- The kind hint the extractor assigned (person / org / location / event / market / product).
- The full article context (title + a faithful English summary, up to 1500 chars).
- 2-5 candidate Wikidata entities, each with their EN label + short description.

Pick the single candidate whose description best fits the article context, OR null if no candidate plausibly fits.

Rules of engagement:
- The article context is the SOLE arbiter. "Vance" in an article about Trump's administration → JD Vance. "Vance" in a 1970s diplomacy retrospective → Cyrus Vance. "Apple" in a tech earnings report → Apple Inc. "Apple" in a recipe → the fruit.
- Reject candidates whose kind clearly doesn't match the kind hint (e.g. extractor said "person" but a candidate is a city). The hint is informative — don't pick the cuisine when the extractor said person.
- Reject disambiguation / placeholder candidates ("Topics referred to by the same term", "may refer to", surname/given-name pages). They're never the right answer.
- Return null when there's genuine ambiguity that the article doesn't resolve. We'd rather mark the mention unlinked and curate later than link the wrong entity.

Confidence calibration:
- 0.9-1.0 = obvious. The article explicitly identifies the entity.
- 0.7-0.9 = highly likely. Description + context align cleanly, no other candidate fits.
- 0.6-0.7 = reasonable inference. Context narrows it down to one plausible candidate.
- <0.6   = not confident enough → return null instead.

Always include a one-sentence `reasoning` explaining WHY you picked (or rejected all). This is for audit and debug — it forces you to commit to a logic, not a gut feel.

Return ONLY a JSON object:
{"qid": "Q12345" or null, "confidence": 0.0-1.0, "reasoning": "one short sentence"}
No markdown, no extra prose.
"""


def disambiguate(
    *,
    client:    OpenAI,
    surface:   str,
    kind:      str,
    candidates: list[WikidataCandidate],
    article_title:   str,
    article_summary: str | None,
) -> DisambiguationResult:
    """Single LLM call that picks one of `candidates` or returns null.

    Pre-filters candidates to drop disambiguation/placeholder pages
    (they're never the right answer and just confuse the LLM). If after
    filtering only one candidate remains, returns it directly without
    calling the LLM — saving cost on a non-decision.

    Returns a `DisambiguationResult`. Caller decides whether to honor
    the choice based on `confidence` vs `CONFIDENCE_FLOOR`.
    """
    # Drop disambiguation placeholders before the LLM ever sees them.
    real_candidates = [c for c in candidates if not c.is_disambiguation_page]
    if not real_candidates:
        return DisambiguationResult(
            qid=None, confidence=0.0, reasoning="no real candidates after filtering disambig pages",
            input_tokens=0, output_tokens=0,
        )

    # Single real candidate after filter → no LLM needed.
    if len(real_candidates) == 1:
        only = real_candidates[0]
        return DisambiguationResult(
            qid=only.qid, confidence=0.9,
            reasoning="single non-disambig candidate after kind/disambig filter",
            input_tokens=0, output_tokens=0,
        )

    # Build a rich user payload — we pass the full English
    # summary (up to 1500 chars) for better disambig context. Candidate
    # descriptions kept tight at 200 chars each (Wikidata descriptions
    # are usually shorter than that anyway).
    cand_payload = [
        {
            "qid":         c.qid,
            "label":       c.label,
            "description": (c.description or "")[:200],
        }
        for c in real_candidates
    ]
    summary_clipped = (article_summary or "")[:1500]

    user_content = json.dumps({
        "article": {
            "title":   article_title,
            "summary": summary_clipped,
        },
        "mention": {
            "surface": surface,
            "kind":    kind,
        },
        "candidates": cand_payload,
    }, ensure_ascii=False)

    t0 = time.perf_counter()
    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": _SYSTEM},
                {"role": "user",   "content": user_content},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=_MAX_OUTPUT_TOKENS,
        )
        raw = response.choices[0].message.content or "{}"
        parsed = json.loads(raw) if isinstance(raw, str) else {}
        if not isinstance(parsed, dict):
            parsed = {}
    except Exception as e:
        _log.warning("disambiguator LLM failure (%s) — falling back to unlinked", e)
        return DisambiguationResult(
            qid=None, confidence=0.0, reasoning=f"LLM error: {type(e).__name__}",
            input_tokens=0, output_tokens=0,
            duration_ms=int((time.perf_counter() - t0) * 1000),
            model=MODEL,
        )
    duration_ms = int((time.perf_counter() - t0) * 1000)

    qid = parsed.get("qid")
    if not (isinstance(qid, str) and qid.startswith("Q")):
        qid = None
    try:
        conf = float(parsed.get("confidence") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    conf = max(0.0, min(1.0, conf))
    reasoning = str(parsed.get("reasoning") or "")[:300]

    # Defensive: the model could hallucinate a Q-id not in our list.
    # If so, reject it — we'd rather be unlinked than wrong.
    if qid is not None and qid not in {c.qid for c in real_candidates}:
        _log.info("disambiguator returned out-of-list QID %s — rejecting", qid)
        qid = None
        conf = 0.0
        reasoning = f"REJECTED out-of-list QID; original: {reasoning}"

    usage = getattr(response, "usage", None)
    return DisambiguationResult(
        qid           = qid,
        confidence    = conf,
        reasoning     = reasoning,
        input_tokens  = getattr(usage, "prompt_tokens", 0) or 0,
        output_tokens = getattr(usage, "completion_tokens", 0) or 0,
        duration_ms   = duration_ms,
        model         = MODEL,
    )


__all__ = ["disambiguate", "DisambiguationResult", "CONFIDENCE_FLOOR"]
