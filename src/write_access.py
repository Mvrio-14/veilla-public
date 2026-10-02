"""
Write access — demo accounts read, pro accounts write.

What a caller may do comes from their `users.plan`, not
from a deployment-wide switch. The same deployment serves read-only
visitors and paying users at once, so the distinction has to live in the
data.

## Why a middleware and not a guard per endpoint

There are more than forty write endpoints. Adding a guard to each one is not
merely tedious — it fails in the wrong direction. The forty-fourth endpoint,
added six months from now by someone who never read this file, would be
open, and nothing would flag it.

A middleware inverts that. Every request with a mutating method is refused
unless it is explicitly allowed, so a new endpoint is protected by default
and has to be *deliberately* exempted to be reachable. The cost of
forgetting is a feature that does not work, not a hole in a public site.

## What an exemption means, and what it does not

An exemption relaxes the PLAN requirement. It never relaxes authentication:
an unauthenticated mutating request is refused here whatever the path, so a
write endpoint declared without an auth dependency is closed by default too
— which is exactly the kind of oversight this file exists to catch.

## Where the line falls: triage is allowed, building is not

The distinction is not "writes versus reads". It is whether the action
produces something the person **authored and will look for again**.

*Triage* is how someone works through the feed in front of them: this is
read, that one does not interest me. It creates no object — it only says
what is left to look at. Refusing it does not make the product feel
restricted, it makes it feel broken. Every reload would show the whole feed
as unread, with stories the visitor already dismissed back at the top, and
they would conclude the thing does not work rather than that they are on a
free tier.

*Building* is saved stories, follows, views, folders, notification
settings — artefacts a person accumulates and expects to find next week.
That is what a pro plan is for.

Hence read and ignore are exempt, in both directions. Un-ignore matters as
much as ignore: being able to hide a story with no way to bring it back is
a trap, not a restriction.

## Ordering note

This middleware must be registered BEFORE the CORS middleware. Starlette
runs the last-registered middleware outermost, so registering CORS after
this one puts CORS on the outside, where it can attach headers to the 401
and 403 produced here. Get it backwards and the browser reports an opaque
network failure instead of showing the real status.
"""
from __future__ import annotations

import re

from fastapi import Request
from fastapi.responses import JSONResponse

# Reaching for a private name is the lesser evil: duplicating an
# authorisation rule guarantees the two copies eventually disagree.
from src.admin.auth import _is_admin_email
from src.auth import _extract_auth, resolve_user_id
from src.db import get_connection

WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

PRO_PLAN = "pro"

# Mutating paths any AUTHENTICATED account may call, whatever its plan.
# Patterns rather than plain strings because two of them carry an id.
#
# Keep this list short, and keep the reason beside each line. Anything that
# creates something a person would expect to find again belongs on the other
# side of the line.
EXEMPT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^/stories/[^/]+/read$"),     # mark one story read
    re.compile(r"^/articles/[^/]+/read$"),    # mark one article read
    re.compile(r"^/me/stories/read-all$"),    # mark the whole feed read
    re.compile(r"^/stories/[^/]+/ignore$"),   # hide a story, and unhide it
)

_READ_ONLY_DETAIL = (
    "This account is read-only. Saving stories, creating views and "
    "following topics require a pro plan."
)


def is_exempt(path: str) -> bool:
    return any(p.match(path) for p in EXEMPT_PATTERNS)


def has_write_access(conn, user_id: str) -> bool:
    """True if the user is on the pro plan."""
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM users WHERE id = %s AND plan = %s",
        (user_id, PRO_PLAN),
    )
    return cur.fetchone() is not None


async def write_access_middleware(request: Request, call_next):
    if request.method not in WRITE_METHODS:
        return await call_next(request)

    # Authentication first, and before any exemption — see the docstring.
    auth = _extract_auth(request.headers.get("authorization"))
    if auth is None:
        return JSONResponse(
            status_code=401, content={"detail": "Authentication required"}
        )

    # Admins are identified by ADMIN_EMAILS and bypass the plan check. Without
    # this, the operator's own account — on the demo plan like everyone
    # else's — could not use /admin at all.
    if _is_admin_email(auth.email):
        return await call_next(request)

    if is_exempt(request.url.path):
        return await call_next(request)

    # One connection per mutating request, on top of the one the handler will
    # open. Writes are a small fraction of traffic and correctness is worth
    # more here than saving a round-trip.
    conn = get_connection()
    try:
        user_id = resolve_user_id(conn, auth)
        if user_id is None:
            return JSONResponse(
                status_code=403, content={"detail": "No account linked"}
            )
        if not has_write_access(conn, user_id):
            return JSONResponse(
                status_code=403, content={"detail": _READ_ONLY_DETAIL}
            )
    finally:
        conn.close()

    return await call_next(request)
