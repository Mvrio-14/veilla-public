"""
Backend → Supabase Realtime broadcast helpers.

Two distinct broadcasts go out at the end of each worker pass:

  1. `broadcast_new_articles_to_user(slug, count)` — per-user, only
     when at least one new article landed in the user's lens. Drives
     the "X nouveaux articles" pill at the top of /watch.

  2. `broadcast_worker_heartbeat(ts_iso)` — global, fires every pass
     regardless of new content or step errors. Drives the
     "updated at HH:MM" indicator so the user sees the system is
     alive even when no new article arrived (a healthy worker that
     happened to find an empty feed cycle).

Both broadcasts go through Supabase Realtime's HTTP API. The backend
uses the service-role-equivalent secret key (`sb_secret_*` in
Supabase's 2024 key system). Channels are public — payloads
carry only counts / timestamps, no sensitive data. Promote to private
mode if we ever push richer content over these topics.

Best-effort: failures are logged but never raise. The ingest pipeline
keeps going even if the broadcast endpoint is unreachable.
"""
import os
from typing import Final

import requests

SUPABASE_URL: Final[str | None] = os.environ.get("SUPABASE_URL")
# Backend-privileged key (the new `sb_secret_*` format from Supabase's
# 2024 key system, equivalent to the legacy service_role JWT). Mirrors
# the frontend's `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` naming.
SUPABASE_SECRET_KEY: Final[str | None] = os.environ.get(
    "SUPABASE_SECRET_KEY"
)

# HTTP timeout. 5s is generous for a single Realtime broadcast call;
# we don't want the ingest loop to hang on a stuck Supabase endpoint.
_BROADCAST_TIMEOUT_S: Final[float] = 5.0


def _broadcast(topic: str, event: str, payload: dict) -> None:
    """
    Low-level Supabase Realtime broadcast POST. Used by the two
    public helpers below — they only differ by topic / event /
    payload shape.

    Silently skips when SUPABASE_URL or SUPABASE_SECRET_KEY isn't
    set (= dev environment without Realtime configured). Logs but
    swallows network and HTTP errors so the worker stays alive.
    """
    if not SUPABASE_URL or not SUPABASE_SECRET_KEY:
        print(
            f"[realtime] broadcast skipped (topic={topic!r}): "
            "SUPABASE_URL or SUPABASE_SECRET_KEY not set",
            flush=True,
        )
        return

    url = f"{SUPABASE_URL}/realtime/v1/api/broadcast"
    try:
        res = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {SUPABASE_SECRET_KEY}",
                "apikey":        SUPABASE_SECRET_KEY,
                "Content-Type":  "application/json",
            },
            json={
                "messages": [
                    {
                        "topic":   topic,
                        "event":   event,
                        "payload": payload,
                        "private": False,
                    }
                ]
            },
            timeout=_BROADCAST_TIMEOUT_S,
        )
        if res.status_code >= 400:
            print(
                f"[realtime] broadcast failed (topic={topic!r}): "
                f"HTTP {res.status_code} {res.text[:200]}",
                flush=True,
            )
        else:
            print(
                f"[realtime] broadcast → {topic} event={event} payload={payload}",
                flush=True,
            )
    except requests.RequestException as e:
        print(
            f"[realtime] broadcast error (topic={topic!r}): "
            f"{type(e).__name__}: {e}",
            flush=True,
        )


def broadcast_new_articles_to_user(user_slug: str, count: int) -> None:
    """
    Push a `new_articles` Realtime broadcast to `user:{user_slug}`.

    Drives the "{count} nouveaux articles — actualiser" pill at the
    top of /watch. Only called when count > 0 — no point alerting a
    user about zero new content.
    """
    _broadcast(
        topic=f"user:{user_slug}",
        event="new_articles",
        payload={"count": count},
    )


def broadcast_user_event(user_slug: str, event: str, payload: dict) -> None:
    """
    Generic per-user broadcast wrapper.

    Used by `src.notifications.emit` to nudge the client when a new
    inbox entry lands (event = "notification:new"). Caller-supplied
    `event` name lets multiple notification-adjacent flows share the
    same channel without adding bespoke helpers per type.
    """
    _broadcast(
        topic=f"user:{user_slug}",
        event=event,
        payload=payload,
    )


def broadcast_worker_heartbeat(ts_iso: str) -> None:
    """
    Push a `pass_complete` heartbeat to the global `worker:heartbeat`
    topic so every connected SPA can update its "updated at HH:MM"
    indicator.

    Fires unconditionally at the end of each worker pass — including
    passes that produced zero new articles or that hit non-fatal
    step_errors. The point is to surface "system is alive" to users,
    independent of whether their specific lens got new content.
    """
    _broadcast(
        topic="worker:heartbeat",
        event="pass_complete",
        payload={"ts": ts_iso},
    )
