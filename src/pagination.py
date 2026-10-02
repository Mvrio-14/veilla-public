"""
Cursor-based pagination helpers.

Encodes / decodes the opaque cursor token used by /watch (and later
/me/saved, /me/folders/{id}). The cursor captures the identity of the
LAST item returned by a page, so the next request can resume strictly
after that point in the stream.

# Cursor payload shape

```json
{
  "r": "2026-06-08T14:30:00.123456+00:00",   // ISO timestamp (item recency)
  "t": "s" | "o",                              // s=story, o=one (singleton)
  "i": 12345                                   // story_id OR article_id
}
```

URL-safe base64 of the JSON serialization. Compact enough to fit a
query param without ?long_urls issues.

# Ordering contract

The /watch stream is sorted by `(recency DESC, id DESC)` — recency
first, id second as deterministic tie-break. The cursor encodes the
last item's (recency, type, id); the next page returns items that
satisfy `cursor_after(item, cursor)`:

  - item.recency  < cursor.recency           → after (older)
  - item.recency == cursor.recency:
      - item.id < cursor.id                  → after (same time, smaller id)
      - else                                 → before or at the cursor (skip)
  - item.recency  > cursor.recency           → before (newer)

`item.type` is NOT part of the ordering predicate — when two items
share recency, only id breaks the tie. The type lives in the cursor
solely so the client can reproduce the EXACT cursor on the next
request if needed (debug, log analysis).

# Forward-compatibility note

Adding a new field to the payload (e.g. "v": 2 for cursor version) is
fine — we ignore unknown fields on decode. Removing or renaming "r" /
"t" / "i" would break old cursors. Keep these stable.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime

CURSOR_TYPE_STORY     = "s"
CURSOR_TYPE_SINGLETON = "o"

# Default page size when /watch is called without an explicit `limit`.
# Sized so the first page fills a typical viewport (~50 cards) and gives
# the SPA enough margin to keep the intersection observer happy while
# the user reads, before the next page must be fetched.
DEFAULT_LIMIT = 50

# Hard cap so a malicious or buggy client can't force the server to
# serialize the whole universe in one shot. Generous enough that a
# legitimate "load everything" intent (e.g. analytics extract) still
# works in one request for any realistic user.
MAX_LIMIT = 500


def encode_cursor(recency: datetime, item_type: str, item_id: int) -> str:
    """Serialize a cursor for the LAST item of a page. The returned
    string is safe to drop in a URL query parameter."""
    payload = {
        "r": recency.isoformat(),
        "t": item_type,
        "i": int(item_id),
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_cursor(token: str | None) -> dict | None:
    """Best-effort decode. Returns None for missing, malformed, or
    invalid cursors — callers treat None as 'start from the top of the
    stream'. We never raise on bad input: a stale or hand-crafted
    cursor that doesn't parse just falls back to a fresh page-1 fetch,
    which is harmless."""
    if not token:
        return None
    try:
        # Re-pad to a multiple of 4 (we strip trailing '=' on encode).
        pad = "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(token + pad)
        payload = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if "r" not in payload or "t" not in payload or "i" not in payload:
        return None
    try:
        recency = datetime.fromisoformat(str(payload["r"]))
        item_id = int(payload["i"])
    except Exception:
        return None
    item_type = str(payload["t"])
    if item_type not in {CURSOR_TYPE_STORY, CURSOR_TYPE_SINGLETON}:
        return None
    return {"recency": recency, "type": item_type, "id": item_id}


def is_after_cursor(
    item_recency: datetime,
    item_id: int,
    cursor: dict,
) -> bool:
    """True iff `(item_recency, item_id)` falls STRICTLY after
    `(cursor.recency, cursor.id)` in the DESC stream ordering.
    Items satisfying this predicate are eligible for the next page."""
    cur_recency: datetime = cursor["recency"]
    cur_id:      int      = cursor["id"]
    if item_recency < cur_recency:
        return True
    if item_recency > cur_recency:
        return False
    return item_id < cur_id


def clamp_limit(raw: int | None) -> int:
    """Coerce a client-supplied `limit` query param into [1, MAX_LIMIT]
    with DEFAULT_LIMIT as the fallback when unset / non-positive."""
    if raw is None or raw <= 0:
        return DEFAULT_LIMIT
    if raw > MAX_LIMIT:
        return MAX_LIMIT
    return int(raw)


# ── Stream pagination ──────────────────────────────────────────────────
#
# The /watch endpoint feeds the SPA's "Tous" tab where stories and
# singletons interleave by recency. `paginate_stream` merges the two
# sorted lists into a single stream, optionally narrows by item_type
# (matches the SPA tabs: "communs"=stories, "originaux"=singletons,
# "all"=both), slices based on the incoming cursor, and emits the
# next_cursor for the page tail.
#
# The full lists are still loaded server-side (= aggregations and
# attach_user_actions_state operate on the full universe before
# slicing). Only the SHIPPED payload shrinks to the page size. Pushing
# pagination into the SQL CTE itself is a later step — the target here
# is the network + frontend-parse bottleneck, not the DB query.


def _story_recency_and_id(s: dict, recency_fn) -> tuple:
    a = s["articles"][0] if s.get("articles") else {}
    return (recency_fn(s), int(a.get("story_id") or 0))


def _singleton_recency_and_id(a: dict, recency_fn) -> tuple:
    return (recency_fn(a), int(a.get("id") or 0))


def paginate_stream(
    stories: list[dict],
    singletons: list[dict],
    cursor: str | None,
    limit: int | None,
    item_type: str,
    story_recency_fn,
    singleton_recency_fn,
) -> tuple[list[dict], list[dict], str | None]:
    """
    Merge stories + singletons into a single recency-sorted stream,
    filter by `item_type`, slice by `cursor`, return the page split
    back into stories + singletons buckets plus the next cursor.

    Args:
        stories, singletons:   full sorted lists from load_watch.
        cursor:                opaque token from a prior page; None for
                               the first page.
        limit:                 client-supplied page size, clamped via
                               `clamp_limit`.
        item_type:             "all" | "communs" | "originaux". Anything
                               else falls back to "all".
        story_recency_fn:      callable(story_dict) -> datetime — the
                               same recency formula load_watch used to
                               sort `stories` (= max of article pub_at).
        singleton_recency_fn:  callable(article_dict) -> datetime — the
                               singleton's own recency.

    Returns: (stories_page, singletons_page, next_cursor). next_cursor
    is None when the page exhausts the filtered stream.
    """
    if item_type not in ("all", "communs", "originaux"):
        item_type = "all"

    stream: list[tuple] = []
    if item_type in ("all", "communs"):
        for s in stories:
            recency, story_id = _story_recency_and_id(s, story_recency_fn)
            stream.append((recency, story_id, CURSOR_TYPE_STORY, s))
    if item_type in ("all", "originaux"):
        for a in singletons:
            recency, article_id = _singleton_recency_and_id(a, singleton_recency_fn)
            stream.append((recency, article_id, CURSOR_TYPE_SINGLETON, a))

    # Recency DESC primary, id DESC tie-break — matches the cursor
    # ordering contract documented at the top of this file.
    stream.sort(key=lambda t: (t[0], t[1]), reverse=True)

    cur = decode_cursor(cursor)
    if cur is not None:
        stream = [t for t in stream if is_after_cursor(t[0], t[1], cur)]

    page_limit = clamp_limit(limit)
    page = stream[:page_limit]

    next_cursor: str | None = None
    if len(stream) > page_limit and page:
        last_recency, last_id, last_type, _ = page[-1]
        next_cursor = encode_cursor(last_recency, last_type, last_id)

    stories_page    = [t[3] for t in page if t[2] == CURSOR_TYPE_STORY]
    singletons_page = [t[3] for t in page if t[2] == CURSOR_TYPE_SINGLETON]
    return stories_page, singletons_page, next_cursor
