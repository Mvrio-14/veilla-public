"""
Admin auth — the `require_admin` FastAPI dependency.

Layered on top of `src.auth.get_required_auth`: an authed user is only
considered admin if their email is in the `ADMIN_EMAILS` env var
(comma-separated). Anything else → 403.

# Why env-var driven (vs. a `users.is_admin` flag)

The admin set is essentially one person. A DB flag adds a column
+ a UI to flip it + a chicken-and-egg ("who creates the first admin?")
problem. An env var is one line to edit and survives DB migrations
unscathed. The trade-off — admin can't elevate themselves at runtime —
is a feature, not a bug: any change to the admin roster requires a
deploy, which is exactly the audit trail we want.

When the team grows we'll port to a flag (likely `users.role TEXT`) —
that's <30 lines of code from here.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, HTTPException

from src.auth import AuthContext, get_required_auth

load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")


def _load_admin_emails() -> set[str]:
    """Read ADMIN_EMAILS env var, normalize to a lower-cased set.

    Empty / unset env returns an empty set → ALL /admin/* requests will
    403. This is the safe default in case a deploy forgets the var.
    """
    raw = os.environ.get("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


# Re-read on every request via a thin wrapper so we don't bake the value
# at module load and ignore env updates that happen after FastAPI booted.
# Cost is negligible: a single string split per request.
def _is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    return email.lower() in _load_admin_emails()


def require_admin(
    auth: AuthContext = Depends(get_required_auth),
) -> AuthContext:
    """FastAPI dependency: require a valid Supabase JWT AND admin email.

    Returns the AuthContext on success, raises 403 otherwise. Endpoint
    handlers receive a fully-resolved AuthContext (email + auth_id),
    which they can pass into `log_action` to credit the actor.

    Usage:

        @app.post("/admin/feeds")
        def create_feed(
            body: FeedCreate,
            auth: AuthContext = Depends(require_admin),
        ): ...
    """
    if not _is_admin_email(auth.email):
        raise HTTPException(
            status_code=403,
            detail="Admin access required",
        )
    return auth
