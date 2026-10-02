"""
Notification dispatch.

Two responsibilities:

  1. `emit(...)` — write a notification to the user's in-app inbox AND,
     when their channel prefs allow it, queue an email send. Both are
     gated by per-user, per-type preferences stored in `users.notif_prefs`.

  2. `fan_out_followers(...)` — the multi-recipient helper. The worker
     calls it when a story moves: it resolves the story's followers,
     then loops `emit()` per user.

# Notification types

One `type` today, stored in the `notifications` table with a JSONB
`payload`:

  - story_update : a followed story got a new article or new
                   story_update.  payload = {
                     story_id, story_title, kind: "new_article"|"new_update",
                     article_id?  (when kind=new_article),
                     update_id?   (when kind=new_update),
                   }

The `payload` is intentionally denormalized for instant display in the
inbox — the worker writes the title/name strings AT EMIT TIME so we
don't need a JOIN at read time, and a later rename of the source row
doesn't rewrite history (the inbox shows what the user actually saw).

# Channel prefs

Lookup order for "should we deliver type T via channel C to user U?":
  1. users.notif_prefs[T][C] if explicitly set (true/false)
  2. DEFAULT_NOTIF_PREFS[T][C]  (server-side defaults below)

If both `in_app` and `email` are False → nothing emitted (type muted).
If only `in_app` → row in `notifications`, no email.
If only `email` → email sent, no row in `notifications`. (Edge case;
   the UI surfaces both prefs so users normally don't end up here.)

# Email
Email send is FIRE-AND-FORGET — `notifications.emit` calls
`email_notifications.send_async` which returns immediately. Failure to
deliver email doesn't roll back the in-app insert. The trade-off: a
500 from Resend is silently lost; we accept that (the in-app
notification still landed, so the user sees it next refresh).

# Realtime
After committing a row to `notifications`, we broadcast
`notification:new` on the `user:{slug}` channel so a logged-in client
can bump the bell badge live without polling. Same pattern as the
`new_articles` broadcast in collector.
"""
from __future__ import annotations

import json
from typing import Any

from src.realtime_broadcast import broadcast_user_event

# ── Type registry ───────────────────────────────────────────────────────────
NOTIF_TYPES = ("story_update",)

# Logical type groupings used in users.notif_prefs. A group can hold
# several types that share one set of channel toggles.
PREF_GROUPS = {
    "story_update": "story_follow",
}

# Server-side defaults — applied when a user has no explicit pref set.
# Echoed verbatim by GET /me/notif-prefs so the Settings UI shows the
# user what's currently active even before they ever opened the form.
DEFAULT_NOTIF_PREFS: dict[str, dict[str, bool]] = {
    # High-intent: user explicitly clicked the bell. Email-ON by default.
    # `include_new_articles` controls the sub-granularity: when False
    # (default), only story_update events emit notifications. When True,
    # the user is also pinged on every new article attached to a
    # followed story. Updates are denser-signal (1-2/day on a hot
    # story); raw articles can fan out to 10+/day from multiple
    # sources, so we don't opt users in by default.
    "story_follow":  {"in_app": True, "email": True, "include_new_articles": False},
}


# ── Pref resolution ─────────────────────────────────────────────────────────
def _merge_group(explicit: dict, defaults: dict[str, bool]) -> dict[str, bool]:
    """Layer explicit user prefs onto the defaults for ONE group.

    Iterates the default's keys (= the canonical set: in_app, email,
    plus per-group extras like `include_new_articles` for story_follow).
    Coerces every value to bool. Unknown keys in `explicit` get dropped
    so the persisted shape stays clean as the schema evolves."""
    if not isinstance(explicit, dict):
        explicit = {}
    return {
        key: bool(explicit.get(key, default))
        for key, default in defaults.items()
    }


def _load_user_prefs(conn, user_id: str) -> dict[str, dict[str, bool]]:
    """Return the user's prefs merged with server defaults.

    Reads `users.notif_prefs` JSONB, falls back to {} when null, then
    layers it on top of `DEFAULT_NOTIF_PREFS`. Returned dict is safe
    to read with `prefs[group]["in_app"]` — every group is guaranteed
    to be present with all its canonical flags.
    """
    cur = conn.cursor()
    cur.execute("SELECT notif_prefs FROM users WHERE id = %s", (user_id,))
    row = cur.fetchone()
    raw: Any = row[0] if row else None
    user_prefs: dict = (
        raw if isinstance(raw, dict)
        else json.loads(raw) if isinstance(raw, str) and raw.strip()
        else {}
    )
    return {
        group: _merge_group(user_prefs.get(group, {}), defaults)
        for group, defaults in DEFAULT_NOTIF_PREFS.items()
    }


def normalize_notif_prefs(raw: object) -> dict[str, dict[str, bool]]:
    """Coerce a client-submitted prefs blob into the canonical shape.

    Used by PUT /me/notif-prefs. Drops unknown keys, coerces flags to
    bool, fills missing flags from defaults so the DB row is always
    self-contained.
    """
    user: dict = raw if isinstance(raw, dict) else {}
    return {
        group: _merge_group(user.get(group, {}), defaults)
        for group, defaults in DEFAULT_NOTIF_PREFS.items()
    }


# ── Single emit ─────────────────────────────────────────────────────────────
def emit(
    conn,
    user_id: str,
    type: str,
    payload: dict,
    *,
    commit: bool = True,
) -> int | None:
    """Deliver a notification to one user across enabled channels.

    Args:
      conn:    psycopg2 connection (caller is responsible for commit
               if `commit=False`).
      user_id: recipient's `users.id`.
      type:    one of NOTIF_TYPES.
      payload: type-specific dict (see module docstring for shapes).
      commit:  set False inside larger transactions; the caller commits.

    Returns:
      The new `notifications.id` if a row was inserted, else None
      (= type was muted in-app OR delivered email-only).

    No-ops silently when both channels are off for this type — that's
    the user's explicit choice. The worker should still call `emit()`
    unconditionally; preference checks are this module's job.
    """
    if type not in NOTIF_TYPES:
        raise ValueError(f"unknown notification type: {type}")

    group = PREF_GROUPS[type]
    prefs = _load_user_prefs(conn, user_id)
    channels = prefs[group]

    # Sub-granularity for story_follow: when the user opted out of
    # per-article pings (default), suppress notifs whose payload kind
    # is "new_article". Updates (kind="new_update") always fire. We
    # treat missing/unknown kind as "update" since the historical
    # contract was updates-only before this toggle existed.
    if type == "story_update" and payload.get("kind") == "new_article":
        if not channels.get("include_new_articles", False):
            return None

    if not channels["in_app"] and not channels["email"]:
        return None  # type fully muted for this user

    notif_id: int | None = None
    if channels["in_app"]:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO notifications (user_id, type, payload)
            VALUES (%s, %s, %s::jsonb)
            RETURNING id
            """,
            (user_id, type, json.dumps(payload)),
        )
        notif_id = cur.fetchone()[0]
        if commit:
            conn.commit()

        # Live bell badge update — broadcast a tiny "wake up, refetch
        # the unread count" event on the user's channel. The payload
        # itself isn't trusted (Realtime broadcasts are at-most-once),
        # the client treats it as a nudge to re-query the API.
        slug = _slug_for(conn, user_id)
        if slug:
            try:
                broadcast_user_event(slug, "notification:new", {"id": notif_id})
            except Exception as e:
                # Best-effort — Realtime hiccups don't roll back the inbox row.
                print(f"[notifications] broadcast failed: {e!r}")

    if channels["email"]:
        # Lazy import — keeps the module light and avoids a hard dep on
        # Resend at import time (worker can run with email off).
        try:
            from src.email_notifications import send_async
            send_async(conn, user_id, type, payload)
        except Exception as e:
            # Resend outages must not block worker passes. Log + swallow.
            print(f"[notifications] email send failed: {e!r}")

    return notif_id


def _slug_for(conn, user_id: str) -> str | None:
    """Best-effort lookup of a user's slug for the Realtime channel name."""
    cur = conn.cursor()
    cur.execute("SELECT slug FROM users WHERE id = %s", (user_id,))
    row = cur.fetchone()
    return row[0] if row else None


# ── Fan-out helpers ─────────────────────────────────────────────────────────
def fan_out_followers(
    conn,
    story_id: int,
    type: str,
    payload: dict,
    *,
    exclude_user_id: str | None = None,
) -> int:
    """Emit `type` to every user following `story_id`.

    `exclude_user_id` skips the originator, for an event caused by a
    user's own action.

    Returns the count of recipients (= the number of `emit` calls,
    including muted ones that didn't insert a row).
    """
    cur = conn.cursor()
    # `expires_at IS NULL OR expires_at > NOW()` skips follows whose TTL
    # has passed (set via the MCP `follow_story` tool). Permanent follows
    # carry NULL and always pass.
    if exclude_user_id is None:
        cur.execute(
            """
            SELECT user_id
              FROM story_follows
             WHERE story_id = %s
               AND (expires_at IS NULL OR expires_at > NOW())
            """,
            (story_id,),
        )
    else:
        cur.execute(
            """
            SELECT user_id
              FROM story_follows
             WHERE story_id = %s
               AND user_id <> %s
               AND (expires_at IS NULL OR expires_at > NOW())
            """,
            (story_id, exclude_user_id),
        )
    user_ids = [row[0] for row in cur.fetchall()]
    for uid in user_ids:
        emit(conn, str(uid), type, payload, commit=False)
    if user_ids:
        conn.commit()
    return len(user_ids)
