"""
What a reader set up: the monitors they can filter on, their saved views
and their folders.
"""
from __future__ import annotations

import json


def load_user_universe(monitors: list[dict]) -> dict:
    """
    Return the FULL universe of filterable values for the current user,
    independent of which articles are currently in the watch.

    Used by the ViewEditDialog (saved views) so the user can define
    criteria against ANY possible value — categories the normalizer can
    output, languages the app supports, feeds the user is subscribed to,
    countries those feeds publish from. Today's empty German section
    shouldn't prevent the user from creating a view filtering on "DE".

    Categories  : the canonical 15 (Other excluded — it's a fallback bucket,
                  semantically weird to filter on).
    Langs       : hardcoded list of ISO codes the app's content can be in;
                  display labels are resolved client-side via `langLabel`.
    Feeds       : the monitors the user follows (`monitors.get_user_monitors`),
                  regardless of whether any item currently surfaces
                  from them. The user is filtering on their subscription.
    Countries   : distinct source_country values from the user's feeds.
                  Same rationale: countries where the user has any
                  subscribed feed, regardless of today's article volume.
    """
    # Import here to avoid pulling the normalizer module into every API
    # request's cold path. CATEGORIES is a tiny constant — no cost.
    from src.normalizer import CATEGORIES

    categories = [c for c in CATEGORIES if c != "Other"]

    # Roughly the langs the normalizer detects + the UI can display. Keep
    # in sync with the frontend `langLabel` helper. If a new lang shows up
    # from the normalizer, add it here; otherwise it won't surface as a
    # filter option for views.
    langs = [
        "en", "fr", "de", "es", "it", "pt", "nl",
        "ja", "zh", "ar", "ru", "ko", "tr", "pl", "sv",
    ]

    feeds_list = [
        {"id": m["id"], "name": m["name"], "country": m["country"], "url": m["url"]}
        for m in monitors
    ]
    # Distinct countries from the user's feeds. Feeds without one are skipped.
    countries_list = [
        {"code": c} for c in sorted({f["country"] for f in feeds_list if f["country"]})
    ]

    return {
        "categories": categories,
        "langs":      langs,
        "feeds":      feeds_list,
        "countries":  countries_list,
    }


# Mirror of the frontend `Advanced` shape's list fields (lib/filter.ts).
# Used by `normalize_advanced_criteria` to guarantee every list is
# present in the criteria payload — older saved views in DB may lack
# fields added later (e.g. articleTypes) which crashes the frontend's
# `criteria.X.length` reads.
#
# MUST mirror exactly the list fields of `Advanced` in
# webapp/lib/filter.ts. If you add a list field there, ALSO add it
# here — otherwise the field gets silently stripped on view load.
_ADVANCED_LIST_FIELDS = (
    "keywords", "categories", "articleTypes", "langs", "feeds",
    "countries", "subjectCountries", "places",
    "persons", "orgs", "events", "markets", "products",
    "excludedCategories", "excludedArticleTypes", "excludedKeywords",
)


def normalize_advanced_criteria(raw: object) -> dict:
    """Server-side mirror of the TS `normalizeAdvanced` helper.

    Ensures every Advanced field is present so any consumer (frontend,
    future API users) can read it without defensive
    checks. Pure read-side normalization — we DON'T write it back to
    the DB (that would be a backfill).

    Called from `_view_row_to_dict` (api.py) and `load_user_views`
    (this module), the two paths that ship view criteria to the SPA.
    """
    raw_dict = raw if isinstance(raw, dict) else {}
    out: dict = {
        "query":         raw_dict["query"] if isinstance(raw_dict.get("query"), str) else "",
        "periodMinutes": int(raw_dict.get("periodMinutes") or 0),
    }
    for field in _ADVANCED_LIST_FIELDS:
        val = raw_dict.get(field)
        out[field] = list(val) if isinstance(val, list) else []
    return out


def load_user_views(conn, user_id: str) -> list[dict]:
    """
    Return the user's saved views, oldest first.

    A view carries (id, name, criteria) — `criteria` is a JSONB blob
    matching the frontend `Advanced` shape (lib/filter.ts). Stories aren't
    stored here; the frontend derives view contents at render time by
    applying `criteria` to the watch payload it already has in memory.

    Owner-only — called from /watch only when the viewer is_owner.
    """
    cur = conn.cursor()
    cur.execute(
        """SELECT id, name, criteria, criteria_text, created_at, updated_at
             FROM views
            WHERE user_id = %s
            ORDER BY created_at ASC""",
        (user_id,),
    )
    out: list[dict] = []
    for row in cur.fetchall():
        sid, name, criteria, criteria_text, created_at, updated_at = row
        # criteria is stored as JSONB — psycopg2 returns it as dict already
        # in most setups; defensively parse if we got a string. Then
        # normalize so the frontend gets every Advanced field present
        # even on older views whose JSONB lacks newer keys.
        if isinstance(criteria, str):
            try:
                criteria = json.loads(criteria)
            except json.JSONDecodeError:
                criteria = {}
        out.append({
            "id":              str(sid),
            "name":            name,
            "criteria":        normalize_advanced_criteria(criteria),
            # Lucene Boolean string. NULL on rows
            # written before the backfill — the frontend uses this if
            # present, falls back to `criteria` otherwise.
            "criteria_text":   criteria_text,
            "created_at":      created_at.isoformat() if created_at else None,
            "updated_at":      updated_at.isoformat() if updated_at else None,
        })
    return out


def load_user_folders(conn, user_id: str) -> list[dict]:
    """
    Return the user's folders for the sidebar, oldest first, each with the
    number of stories filed in it.

    Owner-only — called from /watch and /me/saved when the viewer is the
    watch owner.
    """
    cur = conn.cursor()
    cur.execute(
        """SELECT f.id::text, f.name,
                  COUNT(fs.story_id) AS story_count,
                  f.created_at, f.updated_at
             FROM folders f
        LEFT JOIN folder_stories fs ON fs.folder_id = f.id
            WHERE f.user_id = %s
         GROUP BY f.id
         ORDER BY f.created_at ASC""",
        (user_id,),
    )
    return [
        {
            "id":          row[0],
            "name":        row[1],
            "story_count": int(row[2] or 0),
            "created_at":  row[3].isoformat() if row[3] else None,
            "updated_at":  row[4].isoformat() if row[4] else None,
        }
        for row in cur.fetchall()
    ]
