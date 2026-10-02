"""
Auth — Supabase JWT validation for FastAPI.

The webapp signs the user in via Supabase magic-link (browser side). Each
subsequent request to this API includes the access token:

    Authorization: Bearer <JWT>

This module decodes that JWT (HS256, signed with the Supabase JWT secret),
extracts the auth.users.id (sub claim), and on first sight links it to the
matching public.users row by email so the API can answer "is this requester
the owner of slug X?".

Two FastAPI dependencies:

    get_optional_auth → AuthContext | None
        For endpoints that work for both anon and authed (/watch decides
        access via users.is_public + ownership).

    get_required_auth → AuthContext
        For endpoints that mutate per-user state (future save/hide/etc.).
        401 if the token is missing or invalid.
"""
import os
import re
from dataclasses import dataclass
from pathlib import Path

import jwt
import psycopg2
from dotenv import load_dotenv
from fastapi import Header, HTTPException

from src.monitors import subscribe_to_starter_entries

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# Supabase moved to asymmetric JWT signing (ECC P-256 / ES256) by default for
# new projects. We verify tokens against the project's public JWKS endpoint;
# no shared secret to leak. The JWKS client caches keys with a TTL, so we
# don't pay an HTTP round-trip on every request.
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
JWKS_URL     = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else None
JWT_AUDIENCE = "authenticated"

_jwks_client: jwt.PyJWKClient | None = (
    jwt.PyJWKClient(JWKS_URL, cache_keys=True, max_cached_keys=10) if JWKS_URL else None
)


@dataclass
class AuthContext:
    """A validated Supabase user identity. user_id is filled by resolve_user_id()."""
    auth_id: str          # auth.users.id (UUID, from JWT sub claim)
    email: str | None     # email claim — used for the first-time auth_id link
    user_id: str | None   # public.users.id, populated lazily on first lookup


# ── JWT decoding ────────────────────────────────────────────────────────────
def _decode_jwt(token: str) -> dict:
    if _jwks_client is None:
        raise RuntimeError("SUPABASE_URL not configured")
    signing_key = _jwks_client.get_signing_key_from_jwt(token).key
    return jwt.decode(
        token,
        signing_key,
        algorithms=["ES256"],
        audience=JWT_AUDIENCE,
    )


def _extract_auth(authorization: str | None) -> AuthContext | None:
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
    try:
        payload = _decode_jwt(token)
    except Exception:
        # Bad token, expired, JWKS unreachable, server misconfigured →
        # treat as anonymous. The visibility logic in the endpoint will
        # decide whether anonymous access is OK.
        return None
    sub = payload.get("sub")
    if not sub:
        return None
    return AuthContext(auth_id=sub, email=payload.get("email"), user_id=None)


# ── FastAPI dependencies ────────────────────────────────────────────────────
def get_optional_auth(authorization: str | None = Header(None)) -> AuthContext | None:
    """Return AuthContext if a valid Bearer JWT is present, else None."""
    return _extract_auth(authorization)


def get_required_auth(authorization: str | None = Header(None)) -> AuthContext:
    """Return AuthContext, or raise 401 if the token is missing/invalid."""
    auth = _extract_auth(authorization)
    if auth is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return auth


# ── Self-service provisioning ───────────────────────────────────────────────
# How many times a colliding slug is retried before giving up. Collisions are
# expected — `marie@lemonde.fr` and `marie@lefigaro.fr` both want "marie" —
# but looping forever on a pathological base is not.
_MAX_SLUG_ATTEMPTS = 8

_SLUG_CLEAN = re.compile(r"[^a-z0-9]+")


def _slug_from_email(email: str | None, auth_id: str) -> str:
    """Propose a base slug from the email local part.

    `users.slug` is UNIQUE NOT NULL and user-visible, so it is worth deriving
    from something readable. The auth id is the fallback for identities with
    no email at all — an anonymous or phone signup.
    """
    local = (email or "").split("@", 1)[0].lower()
    base = _SLUG_CLEAN.sub("-", local).strip("-")
    return base or f"u-{auth_id[:8]}"


def _provision_user(conn, auth: AuthContext) -> str | None:
    """Create the public.users row for a first-time caller and subscribe it.

    One transaction: a user that exists but follows no feed would see an
    empty screen with nothing in the logs to explain it, which is worse than
    a request that fails outright. The account starts on the `demo` plan,
    the column default.

    ## The race this guards against

    The web app fires several requests in parallel on first paint. Without
    protection, two of them observe "no such user" at the same moment and
    both insert. `ON CONFLICT (auth_id) DO NOTHING` turns the loser into a
    no-op, which then re-reads the row the winner created. The alternative is
    intermittent 500s on the very first screen a visitor sees — a bug that
    never reproduces locally and always happens in production.

    Slug collisions are a different constraint on the same table, so they
    cannot be folded into that ON CONFLICT clause. They are retried with a
    suffix inside a savepoint, so a failed attempt does not poison the
    surrounding transaction.
    """
    cur = conn.cursor()
    base = _slug_from_email(auth.email, auth.auth_id)
    user_id: str | None = None

    for attempt in range(_MAX_SLUG_ATTEMPTS):
        slug = base if attempt == 0 else f"{base}-{attempt + 1}"
        cur.execute("SAVEPOINT provision")
        try:
            cur.execute(
                """INSERT INTO users (slug, email, auth_id)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (auth_id) DO NOTHING
                   RETURNING id""",
                (slug, auth.email, auth.auth_id),
            )
        except psycopg2.errors.UniqueViolation:
            cur.execute("ROLLBACK TO SAVEPOINT provision")
            continue

        # Read RETURNING before anything else runs on this cursor: RELEASE
        # SAVEPOINT is a statement like any other and would discard the row.
        row = cur.fetchone()
        cur.execute("RELEASE SAVEPOINT provision")
        if row:
            user_id = str(row[0])
        else:
            # ON CONFLICT swallowed the insert: a concurrent request won.
            cur.execute("SELECT id FROM users WHERE auth_id = %s", (auth.auth_id,))
            row = cur.fetchone()
            user_id = str(row[0]) if row else None
        break

    if user_id is None:
        conn.rollback()
        return None

    subscribe_to_starter_entries(cur, user_id)
    conn.commit()
    auth.user_id = user_id
    return user_id


# ── DB linking ──────────────────────────────────────────────────────────────
def resolve_user_id(conn, auth: AuthContext) -> str | None:
    """
    Map the JWT sub (auth.users.id) to a public.users.id.

    Three paths:
      1. A row already has auth_id = sub  → return its id.
      2. No row matches yet but the JWT email matches a users.email whose
         auth_id is still NULL → link them and return the id. This is how a
         seeded account claims itself: the row was provisioned ahead of time,
         the person signs in, and the two are bound. It is the path a paying
         client is onboarded through, so it stays.
      3. Nobody knows this identity → create the row on the demo plan and
         subscribe it to the starter feeds.

    Path 3 is what makes signup self-service, and it deliberately lives here
    rather than behind a `/signup` endpoint. Supabase owns the credential, so
    an endpoint would be a second way to create a user that has to be kept in
    step with this one. Provisioning on first authenticated use has exactly
    one path and works whatever the sign-in method.

    Returns None only if provisioning itself could not complete.
    """
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE auth_id = %s", (auth.auth_id,))
    row = cur.fetchone()
    if row:
        auth.user_id = str(row[0])
        return auth.user_id

    if auth.email:
        cur.execute(
            """UPDATE users
               SET auth_id = %s, updated_at = NOW()
               WHERE auth_id IS NULL AND LOWER(email) = LOWER(%s)
               RETURNING id""",
            (auth.auth_id, auth.email),
        )
        row = cur.fetchone()
        if row:
            conn.commit()
            auth.user_id = str(row[0])
            return auth.user_id

    return _provision_user(conn, auth)
