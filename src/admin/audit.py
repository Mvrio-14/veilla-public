"""
Admin audit log — one row per mutation through /admin/*. Read-side
helpers (`list_actions`) and shape for the /admin/audit viewer live
here too so the writer and reader stay co-located.

The schema (`admin_actions` table) is intentionally minimal:
who, what, when, on what target, with what payload. Reading it from the
UI is straightforward (recency-ordered scan).

# Contract

`log_action` is called from inside an endpoint handler AFTER the actual
mutation succeeds and BEFORE the transaction commits. Both the mutation
and the log row land in the same transaction → either both are persisted
or neither is. No partial-state surprises.

# Action vocabulary

Verbs in snake_case, past tense, prefixed by the entity:
  create_feed, update_feed, soft_delete_feed, hard_delete_feed,
  resurrect_feed,
  create_source, update_source, delete_source,
  create_user, update_user

The full list is conventional, not enforced — adding a new verb just
means writing it in the log call. Reading code (audit viewer) treats it
as opaque text.

# Payload shape

For create / delete: `{"data": <the row as a dict>}`.
For update:         `{"before": <pre-edit row>, "after": <post-edit row>}`.
For bulk:           `{"data": [...], "n": <int>}`.

Free form beyond that — JSONB so we can extend without migrations.
"""
from __future__ import annotations

import json
from typing import Any


def log_action(
    cur,
    *,
    actor_user_id: str | None,
    action:        str,
    target_type:   str,
    target_id:     str | None = None,
    payload:       dict[str, Any] | None = None,
) -> None:
    """Append an audit row. Does NOT commit — caller does.

    Args:
        cur:            psycopg2 cursor on the open transaction
        actor_user_id:  the admin's public.users.id (UUID string). None
                        when we couldn't resolve the actor (= will appear
                        as "(deleted user)" in the viewer)
        action:         snake_case verb — see vocabulary in module docstring
        target_type:    "feed" | "source" | "user" | any new entity we
                        add later
        target_id:      string form of the target's PK (feed/source ids
                        are bigints → cast; user ids are UUIDs already
                        strings). None for actions without a single
                        target (e.g. bulk operations).
        payload:        dict serialized to JSONB. Conventions in the
                        module docstring. None → empty `{}`.
    """
    cur.execute(
        """INSERT INTO admin_actions
               (actor_user_id, action, target_type, target_id, payload)
           VALUES (%s, %s, %s, %s, %s::jsonb)""",
        (
            actor_user_id,
            action,
            target_type,
            target_id,
            json.dumps(payload or {}, default=str),
        ),
    )


# ── Reader ──────────────────────────────────────────────────────────────
def list_actions(
    cur,
    *,
    actor_user_id: str | None = None,
    action:        str | None = None,
    target_type:   str | None = None,
    target_id:     str | None = None,
    before_id:     int | None = None,
    limit:         int           = 100,
) -> list[dict]:
    """Return a page of audit rows, newest first.

    Filters compose with AND when set. `before_id` is the cursor for
    pagination: pass the smallest `id` from the previous page and the
    query returns the next slice. `limit` is capped at 500 to keep
    the JSON payload reasonable.

    Joined columns from `users` (actor email + name + slug) come back
    inlined so the viewer doesn't need a second round-trip to display
    who did what.
    """
    limit = max(1, min(int(limit), 500))
    where:  list[str] = []
    params: list[Any] = []
    if actor_user_id is not None:
        where.append("a.actor_user_id = %s::uuid")
        params.append(actor_user_id)
    if action is not None:
        where.append("a.action = %s")
        params.append(action)
    if target_type is not None:
        where.append("a.target_type = %s")
        params.append(target_type)
    if target_id is not None:
        where.append("a.target_id = %s")
        params.append(target_id)
    if before_id is not None:
        where.append("a.id < %s")
        params.append(int(before_id))
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    params.append(limit)
    cur.execute(
        f"""
        SELECT a.id,
               a.actor_user_id,
               u.slug,
               u.name,
               u.email,
               a.action,
               a.target_type,
               a.target_id,
               a.payload,
               a.created_at
          FROM admin_actions a
          LEFT JOIN users u ON u.id = a.actor_user_id
          {where_sql}
         ORDER BY a.id DESC
         LIMIT %s
        """,
        params,
    )
    rows = cur.fetchall()
    return [
        {
            "id":             int(r[0]),
            "actor_user_id":  str(r[1]) if r[1] else None,
            "actor_slug":     r[2],
            "actor_name":     r[3],
            "actor_email":    r[4],
            "action":         r[5],
            "target_type":    r[6],
            "target_id":      r[7],
            "payload":        r[8] or {},
            "created_at":     r[9].isoformat() if r[9] else None,
        }
        for r in rows
    ]
