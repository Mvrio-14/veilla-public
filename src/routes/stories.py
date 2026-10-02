"""
Per-user state on a single story or article: save, follow, ignore, read.

These carry no prefix because two shapes live side by side — a story is
acted on at `/stories/{id}/…` and an article at `/articles/{id}/read` —
and inventing a common parent would only obscure that.

Marking something read or hidden is exempt from the pro-plan check in
`src/write_access.py`: it is triage, not authoring. See that module for
where the line falls and why.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from src.auth import AuthContext, get_required_auth, resolve_user_id
from src.db import get_connection
from src.routes._shared import _ensure_story_exists

router = APIRouter(tags=["stories"])


@router.post("/stories/{story_id}/save")
def save_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Save a story to the user's long-term library. Idempotent.

    Save and Folder are fully independent (mirrors
    the Gmail / Feedly model where Star and Labels live on separate
    axes). Saving does not create a pin row, and unsaving does not
    remove the story from the user's folders. Each action does
    exactly what its name says.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        _ensure_story_exists(conn, story_id)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO user_story_saves (user_id, story_id)
               VALUES (%s, %s)
               ON CONFLICT (user_id, story_id) DO NOTHING""",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/stories/{story_id}/save")
def unsave_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Remove a story from the user's library. Idempotent.

    Save and Folder are independent — unsave does not cascade to
    folder_stories. A story can sit in folders
    without being saved (the cleanup pg_cron knows to protect anything
    referenced from `folder_stories`).
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM user_story_saves WHERE user_id = %s AND story_id = %s",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/stories/{story_id}/follow")
def follow_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Subscribe the caller to notifications about this story.
    Idempotent. The user receives a `story_update` notification
    when:
      - a new article attaches to the story (clusterer hook)
      - a new story_update lands on the story (story_state hook)

    Per-channel delivery (in-app vs email) is gated by the user's
    `notif_prefs` — see `src/notifications.py::emit`.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        _ensure_story_exists(conn, story_id)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO story_follows (user_id, story_id)
               VALUES (%s, %s)
               ON CONFLICT (user_id, story_id) DO NOTHING""",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/stories/{story_id}/follow")
def unfollow_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """Unsubscribe the caller from this story's notifications. Idempotent.

    Doesn't touch existing inbox rows — past notifications stay readable;
    only future events are suppressed."""
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM story_follows WHERE user_id = %s AND story_id = %s",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/stories/{story_id}/ignore")
def ignore_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        _ensure_story_exists(conn, story_id)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO user_story_ignores (user_id, story_id)
               VALUES (%s, %s)
               ON CONFLICT (user_id, story_id) DO NOTHING""",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.delete("/stories/{story_id}/ignore")
def unignore_story(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM user_story_ignores WHERE user_id = %s AND story_id = %s",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/stories/{story_id}/read")
def mark_story_read(
    story_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Marks a story as seen by the user (read_at = NOW()). Called silently by
    the SPA when the user opens a story's detail panel. Re-calling resets
    read_at, which is what we want — if the story got new articles after the
    user last looked, the next click marks it freshly read.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        _ensure_story_exists(conn, story_id)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO user_story_reads (user_id, story_id, read_at)
               VALUES (%s, %s, NOW())
               ON CONFLICT (user_id, story_id)
               DO UPDATE SET read_at = NOW()""",
            (viewer_user_id, story_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}


@router.post("/articles/{article_id}/read")
def mark_article_read(
    article_id: int,
    auth: AuthContext = Depends(get_required_auth),
) -> dict:
    """
    Marks an article as read by the user.

    Fired by the SPA on per-article click inside a cluster expand AND on
    cluster close (then in parallel for every article in the closed
    cluster). Idempotent — POSTing twice is a no-op apart from refreshing
    read_at.
    """
    conn = get_connection()
    try:
        viewer_user_id = resolve_user_id(conn, auth)
        if viewer_user_id is None:
            raise HTTPException(status_code=403, detail="No account linked")
        cur = conn.cursor()
        cur.execute(
            "SELECT 1 FROM items WHERE id = %s",
            (article_id,),
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail=f"Article {article_id} not found")
        cur.execute(
            """INSERT INTO user_item_reads (user_id, item_id, read_at)
               VALUES (%s, %s, NOW())
               ON CONFLICT (user_id, item_id)
               DO UPDATE SET read_at = NOW()""",
            (viewer_user_id, article_id),
        )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True}
