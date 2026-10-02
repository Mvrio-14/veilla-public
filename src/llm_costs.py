"""
LLM cost tracking.

Helper module that persists every OpenAI call to the `llm_calls` audit
table so the cost data is queryable in SQL ("how much did the
normalizer spend yesterday?", "what does one story cost end to end?").

# What lives here

  - `PRICES`            : single source of truth for per-model pricing.
  - `estimate_cost()`   : turn (model, in_tokens, out_tokens) into USD.
  - `log_call()`        : INSERT one row into `llm_calls` using the
                          caller's connection. Best-effort: swallows
                          errors so a logging failure never blocks the
                          pipeline.

# What does NOT live here

The actual `client.chat.completions.create(...)` calls stay in their
domain modules (normalizer, extractor, story_state, …). Each call
site is responsible for:
  1. Making the API call.
  2. Computing/extracting input_tokens, output_tokens, duration_ms.
  3. Calling `log_call(conn, ...)` with whatever context it has
     (user_id, view_id, story_id, item_id — pass what you've got,
     None is fine).

That keeps the LLM call sites domain-shaped (testable without a DB)
while still funnelling all of them through one auditable persistence
helper.

# Commit semantics

`log_call` uses the caller's connection. The insert lands in the
caller's open transaction; it commits when the caller commits.
Consequence: if the caller rolls back AFTER the LLM call succeeded,
the audit row is lost too. This is acceptable for early-stage — most
failures we care about happen on the wire (the call itself raised),
and those we log explicitly with success=False before bubbling up.
"""
from __future__ import annotations

# ─────────────────────────────────────────────────────────────────────
# Single source of truth for OpenAI pricing (USD per 1M tokens).
# Update when OpenAI re-prices a tier; every cost figure, logged or
# printed, goes through `estimate_cost`.
# ─────────────────────────────────────────────────────────────────────
PRICES: dict[str, dict[str, float]] = {
    # Every text step (src/llm_models.py). Reasoning tokens are billed,
    # and reported by the API, as output.
    "gpt-6-luna":             {"in": 0.10,  "out": 0.50},
    # Embedder: only input tokens billed
    "text-embedding-3-small": {"in": 0.02,  "out": 0.0},
    # Cached-input rates aren't tracked — OpenAI exposes
    # prompt_tokens_details.cached_tokens in response.usage but we don't
    # read it. Treating every input token as non-cached over-estimates
    # spend slightly.
}


def estimate_cost(
    model:         str,
    *,
    input_tokens:  int,
    output_tokens: int,
) -> float:
    """Compute the USD cost of one call from token counts.

    Unknown model returns 0.0 — the row still gets logged (with the
    unknown model name) so we can backfill cost later by updating the
    PRICES table + re-running an UPDATE.
    """
    p = PRICES.get(model)
    if p is None:
        return 0.0
    return (input_tokens * p["in"] + output_tokens * p["out"]) / 1_000_000


def log_call(
    conn,
    *,
    model:         str,
    step:          str,
    input_tokens:  int                  = 0,
    output_tokens: int                  = 0,
    cost_usd:      float | None      = None,
    purpose:       str | None        = None,
    user_id:       str | None        = None,
    view_id:       str | None        = None,
    story_id:      int | None        = None,
    item_id:       int | None        = None,
    duration_ms:   int | None        = None,
    success:       bool                 = True,
    error:         str | None        = None,
) -> None:
    """Persist one LLM call to `llm_calls`.

    Args:
        conn:          active psycopg2 connection. We don't commit;
                       the caller's transaction owns commit cadence.
        model:         OpenAI model identifier ('gpt-6-luna',
                       'text-embedding-3-small', …).
        step:          pipeline step name matching `step_timer` IDs
                       in `src/runner.py`.
        input_tokens / output_tokens:
                       from the API response's `usage` object.
        cost_usd:      pre-computed USD cost. When None, derived from
                       (model, tokens) via `estimate_cost`.
        purpose:       optional sub-step label (e.g. 'batch' vs
                       'single', 'origin' vs 'delta').
        user_id / view_id / story_id / item_id:
                       optional context for slicing. Pass what the
                       call site has; None is fine for any of them.
        duration_ms:   wall-clock duration of the API round-trip.
        success:       False when the API call raised. Set `error` to
                       the exception class + message for audit.
        error:         exception summary string when success=False.

    Best-effort: any insert failure (DB down, schema mismatch) is
    caught and logged to stdout — we never re-raise from this helper.
    """
    if cost_usd is None:
        cost_usd = estimate_cost(
            model, input_tokens=input_tokens, output_tokens=output_tokens,
        )

    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO llm_calls (
                model, step, purpose,
                user_id, view_id, story_id, item_id,
                input_tokens, output_tokens, cost_usd,
                duration_ms, success, error
            )
            VALUES (
                %s, %s, %s,
                %s::uuid, %s::uuid, %s, %s,
                %s, %s, %s,
                %s, %s, %s
            )
            """,
            (
                model, step, purpose,
                user_id, view_id, story_id, item_id,
                int(input_tokens or 0), int(output_tokens or 0), float(cost_usd or 0.0),
                duration_ms, bool(success), error,
            ),
        )
    except Exception as e:
        print(f"  [llm_costs] log_call failed step={step} model={model}: "
              f"{type(e).__name__}: {e}", flush=True)
