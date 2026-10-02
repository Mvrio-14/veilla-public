"""
Values shared by more than one router.

Deliberately small. Anything used by a single domain belongs in that
domain's module, next to the routes that read it; putting it here would
only make a reader look in two places.
"""

# Cache-Control applied to read-only data endpoints. The CDN serves the
# cached response for `max-age` seconds, then serves it stale for up to
# `stale-while-revalidate` seconds while refreshing in the background —
# so nobody waits on a cache miss boundary.
DATA_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300"

# Authenticated responses are specific to one person: a different
# `viewer.is_owner`, a different set of saved and hidden stories. No CDN
# may hold them, let alone hand them to somebody else.
DATA_CACHE_PRIVATE = "private, no-store"

WINDOW_HOURS_MIN = 2

# Seven days: the widest window a reader's preferences may ask for. Its
# cost grows with the number of monitors the reader follows.
WINDOW_HOURS_MAX = 168


from fastapi import HTTPException

_PREFERENCES_LIST_FIELDS = (
    "keywords", "categories", "articleTypes", "langs", "feeds",
    "countries", "subjectCountries", "places",
    "persons", "orgs", "events", "markets", "products",
    "excludedCategories", "excludedArticleTypes", "excludedKeywords",
)


def _empty_preferences() -> dict:
    """Default preferences = no filters, see everything. Matches the
    frontend `emptyAdvanced`."""
    return {
        "query":        "",
        "periodMinutes": 0,
        **{field: [] for field in _PREFERENCES_LIST_FIELDS},
    }


def _normalize_preferences(raw: object) -> dict:
    """Coerce an arbitrary JSON blob into a valid preferences dict.

    Defensive: we accept anything the client sends and pour it into the
    canonical shape, dropping unknown fields and clamping types. Keeps
    the DB clean even if the frontend ships a regression.
    """
    out = _empty_preferences()
    if not isinstance(raw, dict):
        return out
    pm = raw.get("periodMinutes")
    if isinstance(pm, (int, float)) and pm >= 0:
        out["periodMinutes"] = int(pm)
    q = raw.get("query")
    if isinstance(q, str):
        out["query"] = q
    for field in _PREFERENCES_LIST_FIELDS:
        val = raw.get(field)
        if isinstance(val, list):
            # Keep only strings, trim, drop empties + duplicates while
            # preserving insertion order.
            cleaned: list[str] = []
            seen: set[str] = set()
            for x in val:
                if not isinstance(x, str):
                    continue
                s = x.strip()
                if not s or s in seen:
                    continue
                cleaned.append(s)
                seen.add(s)
            out[field] = cleaned
    return out


def _ensure_story_exists(conn, story_id: int) -> None:
    cur = conn.cursor()
    cur.execute("SELECT 1 FROM stories WHERE id = %s", (story_id,))
    if cur.fetchone() is None:
        raise HTTPException(status_code=404, detail=f"Story {story_id} not found")
