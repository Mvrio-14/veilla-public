"""
The story layer every screen renders the same way: label and synthesis,
origin and timeline in the reader's language, the reader's own state
(saved, read, followed…) and the categories and title a card shows.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from src.loaders.common import parse_json_field


def load_story_updates(
    conn,
    story_ids: list[int],
    visible_article_ids: list[int],
    output_lang: str,
) -> dict[int, list[dict]]:
    """
    Load timeline rows (story_updates) per story, filtered to those whose
    source article is visible to the current user, with content resolved
    to the user's output_lang.

    Per-user filtering is just `source_item_id = ANY(visible_ids)` —
    each update has exactly one source article (per-article streaming).
    Translation is read from the JSONB cache populated by story_translator;
    falls back to canonical EN content when the cache hasn't caught up.

    Timestamp returned is the SOURCE ARTICLE's `published_at` rather than
    `story_updates.added_at` — the reader cares about when the news actually
    happened, not when our worker inserted the row. Falls back to added_at
    when the article has no published date (rare; mostly archive seeds).
    Sorted DESC by that effective time so "latest news first" holds.
    """
    if not story_ids or not visible_article_ids:
        return {}
    cur = conn.cursor()
    # items.published_at and story_updates.added_at are both TIMESTAMPTZ
    # so COALESCE them directly — no cast needed.
    cur.execute("""
        SELECT u.story_id, u.content, u.translations,
               COALESCE(a.published_at, u.added_at)
                 AS event_time,
               u.source_item_id
        FROM story_updates u
        JOIN items a ON a.id = u.source_item_id
        WHERE u.story_id = ANY(%s)
          AND u.source_item_id = ANY(%s)
        ORDER BY u.story_id, event_time DESC
    """, (story_ids, visible_article_ids))
    out: dict[int, list[dict]] = {}
    for sid, content, translations_raw, event_time, _src_id in cur.fetchall():
        translations = parse_json_field(translations_raw)
        display = (
            translations.get(output_lang)
            if output_lang and output_lang != "en"
            else None
        ) or content
        out.setdefault(sid, []).append({
            "content":  display,
            "added_at": event_time.isoformat() if event_time else None,
        })
    return out


def load_story_origins(
    conn,
    story_ids: list[int],
    output_lang: str,
) -> dict[int, str]:
    """
    Load the origin paragraph per story, resolved to the user's output_lang.

    Reads stories.origin_normalized + origin_translations and picks the
    target-lang translation when cached; otherwise returns the canonical
    EN paragraph. Stories without an origin (a single article, or
    story_state hasn't run yet) are simply absent from the dict — callers
    should treat that as "no origin available, render nothing".
    """
    if not story_ids:
        return {}
    cur = conn.cursor()
    cur.execute("""
        SELECT id, origin_normalized, origin_translations
        FROM stories
        WHERE id = ANY(%s)
          AND origin_normalized IS NOT NULL
          AND TRIM(origin_normalized) <> ''
    """, (story_ids,))
    out: dict[int, str] = {}
    for sid, origin_text, translations_raw in cur.fetchall():
        translations = parse_json_field(translations_raw)
        display = (
            translations.get(output_lang)
            if output_lang and output_lang != "en"
            else None
        ) or origin_text
        out[sid] = display
    return out


def _load_user_actions_for_stories(
    conn, user_id: str, story_ids: list[int],
) -> dict[int, dict]:
    """
    Look up per-user action state for the given stories.

    Returns a dict story_id → {saved, ignored, read_at, is_unread,
    has_update}. Stories with no action record show up as empty
    defaults, never absent — so the caller can blindly index by
    story_id.

    There is no pin state: the SPA's UserState type has it as optional.
    """
    if not story_ids:
        return {}
    cur = conn.cursor()

    cur.execute(
        "SELECT story_id FROM user_story_saves "
        "WHERE user_id = %s AND story_id = ANY(%s)",
        (user_id, story_ids),
    )
    saved = {row[0] for row in cur.fetchall()}

    cur.execute(
        "SELECT story_id FROM user_story_ignores "
        "WHERE user_id = %s AND story_id = ANY(%s)",
        (user_id, story_ids),
    )
    ignored = {row[0] for row in cur.fetchall()}

    cur.execute(
        "SELECT story_id, read_at FROM user_story_reads "
        "WHERE user_id = %s AND story_id = ANY(%s)",
        (user_id, story_ids),
    )
    reads = {row[0]: row[1] for row in cur.fetchall()}

    cur.execute(
        "SELECT id, latest_pub FROM stories WHERE id = ANY(%s)",
        (story_ids,),
    )
    latest_pub = {row[0]: row[1] for row in cur.fetchall()}

    cur.execute(
        "SELECT story_id FROM story_follows "
        "WHERE user_id = %s AND story_id = ANY(%s)",
        (user_id, story_ids),
    )
    followed = {row[0] for row in cur.fetchall()}

    out = {}
    for sid in story_ids:
        rd = reads.get(sid)
        lp = latest_pub.get(sid)
        # Unread = never read at all OR there's been new activity since.
        is_unread = rd is None or (lp is not None and rd < lp)
        # Updated specifically = was read once, but new articles arrived after.
        has_update = rd is not None and lp is not None and rd < lp
        out[sid] = {
            "saved":      sid in saved,
            "ignored":    sid in ignored,
            "followed":   sid in followed,
            "is_unread":  is_unread,
            "has_update": has_update,
            # Exposed so the SPA can mark per-article "new since last read"
            # (a blue dot inside the cluster expand).
            "read_at":    rd.isoformat() if rd else None,
        }
    return out


def attach_user_actions_state(
    conn, user_id: str, stories: list[dict], singletons: list[dict],
) -> None:
    """
    Mutate `stories` and `singletons` to add a `user_state` field per item.

    Only call this when the viewer is the owner of the watch — the response
    shape is "user_state present = enabled buttons" on the frontend, so
    surfacing it for non-owners would be misleading.
    """
    sids: list[int] = []
    for s in stories:
        sid = s["articles"][0].get("story_id") if s.get("articles") else None
        if sid is not None:
            sids.append(sid)
    for a in singletons:
        sid = a.get("story_id")
        if sid is not None:
            sids.append(sid)

    state_map = _load_user_actions_for_stories(conn, user_id, list(set(sids)))

    for s in stories:
        sid = s["articles"][0].get("story_id") if s.get("articles") else None
        s["user_state"] = state_map.get(sid) if sid is not None else None
    for a in singletons:
        sid = a.get("story_id")
        a["user_state"] = state_map.get(sid) if sid is not None else None


def attach_folder_membership(
    conn,
    user_id: str,
    stories: list[dict],
    singletons: list[dict],
) -> None:
    """
    Populate `user_state.folder_ids` (list of folder UUIDs as strings) on
    every story / singleton item where a `user_state` is already attached,
    so the FolderPickerDialog opens with the right boxes checked.

    Call AFTER `attach_user_actions_state`. Items without a user_state
    (non-owner viewers) are skipped — folder membership is owner-only data.
    """
    sids: list[int] = []
    for s in stories:
        if s.get("user_state") is None:
            continue
        sid = s["articles"][0].get("story_id") if s.get("articles") else None
        if sid is not None:
            sids.append(sid)
    for a in singletons:
        if a.get("user_state") is None:
            continue
        sid = a.get("story_id")
        if sid is not None:
            sids.append(sid)

    folder_map: dict[int, list[str]] = defaultdict(list)
    if sids:
        cur = conn.cursor()
        cur.execute(
            """SELECT fs.story_id, fs.folder_id::text
                 FROM folder_stories fs
                 JOIN folders        f  ON f.id = fs.folder_id
                WHERE f.user_id = %s
                  AND fs.story_id = ANY(%s)""",
            (user_id, list(set(sids))),
        )
        for story_id, folder_id in cur.fetchall():
            folder_map[story_id].append(folder_id)

    for s in stories:
        if s.get("user_state") is None:
            continue
        sid = s["articles"][0].get("story_id") if s.get("articles") else None
        s["user_state"]["folder_ids"] = list(folder_map.get(sid, []))
    for a in singletons:
        if a.get("user_state") is None:
            continue
        sid = a.get("story_id")
        a["user_state"]["folder_ids"] = list(folder_map.get(sid, []))


def load_story_texts(
    conn, story_ids: list[int], output_lang: str,
) -> dict[int, dict]:
    """Each story's label and synthesis, in the reader's language.

    Both are written once per story in English by the worker, then
    translated once per language in use and cached on the story row
    (`label_translations`, `synthesis_translations`). Every reader of a
    given language therefore sees the same wording.

    Falls back to the English text while a translation is still pending,
    so a new story is never shown without a title.
    """
    if not story_ids:
        return {}
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, label, label_lang, label_translations,
               synthesis_normalized, synthesis_translations
          FROM stories
         WHERE id = ANY(%s)
        """,
        (story_ids,),
    )
    out: dict[int, dict] = {}
    for sid, label, label_lang, label_tr, synthesis, synthesis_tr in cur.fetchall():
        if (label_lang or "").lower() == output_lang:
            display_label = label
        else:
            display_label = parse_json_field(label_tr).get(output_lang) or label
        if output_lang == "en":
            display_synthesis = synthesis
        else:
            display_synthesis = (
                parse_json_field(synthesis_tr).get(output_lang) or synthesis
            )
        out[sid] = {
            "label":     display_label or "",
            "synthesis": display_synthesis or None,
        }
    return out


def _top_categories(articles: list[dict], n: int = 2) -> list[str]:
    cats = Counter(
        a["category"][0]
        for a in articles
        if a.get("category") and a["category"][0] != "Other"
    )
    return [c for _, (c, _) in zip(range(n), cats.most_common(n))]


def _pick_title(articles: list[dict]) -> str:
    """Last-resort title for a story that has no label yet: its longest article title."""
    return max(
        (a.get("title") or "" for a in articles),
        key=len, default=""
    )


def enrich_for_render(
    visible_articles: list[dict],
    display_label: str,
    display_synthesis: str | None = None,
    display_origin: str | None = None,
    updates: list[dict] | None = None,
) -> dict:
    """Cluster-shaped dict consumed by /watch."""
    publishers = list(dict.fromkeys(a["source"] for a in visible_articles))
    n_sources  = len(publishers)
    return {
        "title":      display_label or _pick_title(visible_articles),
        "origin":     display_origin or None,
        "synthesis":  display_synthesis or None,
        "updates":    updates or [],
        "sources":    publishers,
        "n_sources":  n_sources,
        "image_url":  next((a["image_url"] for a in visible_articles if a.get("image_url")), None),
        "articles":   visible_articles,
        "categories": _top_categories(visible_articles),
        "type":       "cluster",
    }
