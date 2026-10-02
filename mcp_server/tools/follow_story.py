"""
follow_story / unfollow_story — MCP tools.

`follow_story` subscribes the current user to a specific story so the worker
fires a `story_update` notification each time a new article is clustered
into it OR a delta paragraph is emitted by story_state (gated by
the user's `notif_prefs.story_follow` channel preferences). `unfollow_story`
reverses the action.

# TTL via `expires_at`

`duration_hours` lets the assistant set a temporary follow. NULL means
permanent (the previous default behaviour of the bell icon in the SPA).
A future timestamp means the worker stops firing notifs once NOW() crosses
it — the row stays in the table for audit / extension purposes, see
`src/notifications.py::fan_out_followers`.

Acts as the single user named by VEILLA_MCP_USER_SLUG (see
mcp_server/_identity.py).
"""
from datetime import datetime, timedelta, timezone

from mcp_server._identity import current_user_slug
from src.db import get_connection

# Cap on the TTL the LLM can set in one call. 30 days is a generous ceiling
# for a temporary follow — anything longer should probably be a permanent
# subscription. Keeps the assistant from accidentally creating a follow
# with a multi-year horizon when the user said "for a while".
MAX_DURATION_HOURS = 30 * 24


def _validate_duration_hours(duration_hours: int | None) -> int | None:
    if duration_hours is None:
        return None
    if not isinstance(duration_hours, int) or duration_hours <= 0:
        raise ValueError(
            f"duration_hours must be a positive integer or None, "
            f"got {duration_hours!r}"
        )
    if duration_hours > MAX_DURATION_HOURS:
        raise ValueError(
            f"duration_hours capped at {MAX_DURATION_HOURS} "
            f"(= 30 days), got {duration_hours}"
        )
    return duration_hours


def follow_story(
    story_id: int,
    duration_hours: int | None = None,
) -> dict:
    """Subscribe the current user to a story (= turn on its bell).

    The worker fires a `story_update` notification on every new article
    clustered into the story and on every delta paragraph emitted. Channel
    delivery (in-app / email) follows the user's `notif_prefs.story_follow`
    settings, and the `include_new_articles` sub-toggle (default off)
    decides whether `kind=new_article` events fire too.

    Args:
        story_id: integer story id (e.g. from `search_stories` or
            `get_story`).
        duration_hours: optional TTL in hours. None = permanent follow
            (same as the bell button in the SPA). A positive integer
            sets `expires_at = NOW() + N hours`; the worker filters
            expired follows at firing time. Max 30 days (720 hours).

    Returns:
        A dict with:
          - story_id, user_slug
          - followed_at: ISO timestamp (when this follow was created /
            re-created)
          - expires_at: ISO timestamp or None (permanent)
          - was_new: bool — True if a row was inserted, False if the user
            already followed this story (the TTL is REFRESHED in both
            cases when `duration_hours` is set)

    This is a write action: the doctrine asks for confirmation before
    calling it unless the user's request is unambiguous ("follow story
    42 for 48 hours").
    """
    if not isinstance(story_id, int) or story_id <= 0:
        raise ValueError(f"story_id must be a positive integer, got {story_id!r}")

    duration_hours = _validate_duration_hours(duration_hours)

    conn = get_connection()
    try:
        cur = conn.cursor()

        # The user the server acts as, from the configured slug.
        cur.execute("SELECT id FROM users WHERE slug = %s", (current_user_slug(),))
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"User slug {current_user_slug()!r} not found")
        user_id = row[0]

        # Sanity: the story must exist. Helps the LLM get a clean error
        # instead of a silent no-op when it hallucinates an id.
        cur.execute("SELECT 1 FROM stories WHERE id = %s", (story_id,))
        if cur.fetchone() is None:
            raise ValueError(f"Story {story_id} does not exist")

        expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=duration_hours)
            if duration_hours is not None else None
        )

        # ON CONFLICT branch lets us re-arm an existing follow with a new
        # TTL — "follow this for another 48h" should reset the timer,
        # not error. RETURNING xmax = 0 detects whether the row was new
        # (xmax = 0 on insert, nonzero on update).
        cur.execute(
            """
            INSERT INTO story_follows (user_id, story_id, followed_at, expires_at)
                 VALUES (%s, %s, NOW(), %s)
            ON CONFLICT (user_id, story_id)
                  DO UPDATE SET expires_at = EXCLUDED.expires_at,
                                followed_at = NOW()
              RETURNING followed_at, (xmax = 0) AS was_new
            """,
            (user_id, story_id, expires_at),
        )
        followed_at, was_new = cur.fetchone()
        conn.commit()
    finally:
        conn.close()

    return {
        "story_id":    story_id,
        "user_slug":   current_user_slug(),
        "followed_at": followed_at.isoformat() if followed_at else None,
        "expires_at":  expires_at.isoformat() if expires_at else None,
        "was_new":     bool(was_new),
    }


def unfollow_story(story_id: int) -> dict:
    """Unsubscribe the current user from a story (= turn off its bell).

    Idempotent: returns `was_following=False` if the user wasn't following
    the story to begin with (no error).

    Args:
        story_id: integer story id.

    Returns:
        A dict with story_id, user_slug, was_following (bool).

    This is a write action — confirm first unless the request is
    unambiguous ("unfollow story 42").
    """
    if not isinstance(story_id, int) or story_id <= 0:
        raise ValueError(f"story_id must be a positive integer, got {story_id!r}")

    conn = get_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM users WHERE slug = %s", (current_user_slug(),))
        row = cur.fetchone()
        if row is None:
            raise RuntimeError(f"User slug {current_user_slug()!r} not found")
        user_id = row[0]

        cur.execute(
            "DELETE FROM story_follows WHERE user_id = %s AND story_id = %s",
            (user_id, story_id),
        )
        was_following = cur.rowcount > 0
        conn.commit()
    finally:
        conn.close()

    return {
        "story_id":      story_id,
        "user_slug":     current_user_slug(),
        "was_following": was_following,
    }
