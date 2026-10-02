"""
Admin domain logic for Users.

What this module covers:

  - `list_users` — table for the /admin/users page (slug, email, lang,
    active, plan).
  - `get_user` — single-user detail, same shape.
  - `create_user` — insert a row into `public.users`. Does NOT create
    the Supabase Auth account; the admin still does that step in the
    Supabase Dashboard (and the `auth_id` gets linked lazily at first
    login via email match).
  - `update_user` — edit profile fields including slug, email and plan.
    The Supabase Auth row is NOT mutated; we surface the caveat in the UI.

Same convention as other admin modules: pure functions over a cursor,
caller owns transaction + commit.
"""
from __future__ import annotations

from typing import Any

# What a user may do: `demo` reads, `pro` can also save, file and create.
# Mirrors the CHECK constraint on `users.plan`.
PLANS = frozenset({"demo", "pro"})

_USER_SELECT_COLS = """
    u.id, u.slug, u.name, u.email, u.output_lang, u.active, u.is_public,
    u.created_at, u.updated_at, u.plan
"""


def _user_row_to_dict(r: tuple) -> dict:
    return {
        "id":          str(r[0]),
        "slug":        r[1],
        "name":        r[2],
        "email":       r[3],
        "output_lang": r[4],
        "active":      bool(r[5]) if r[5] is not None else True,
        "is_public":   bool(r[6]) if r[6] is not None else False,
        "created_at":  r[7].isoformat() if r[7] else None,
        "updated_at":  r[8].isoformat() if r[8] else None,
        "plan":        r[9],
    }


def list_users(cur) -> list[dict]:
    """Return every public.users row. The /admin/users UI tables this
    directly."""
    cur.execute(
        f"""
        SELECT {_USER_SELECT_COLS}
          FROM users u
         ORDER BY u.name ASC NULLS LAST, u.slug ASC
        """
    )
    return [_user_row_to_dict(r) for r in cur.fetchall()]


def get_user(cur, user_id: str) -> dict | None:
    cur.execute(
        f"""
        SELECT {_USER_SELECT_COLS}
          FROM users u
         WHERE u.id = %s::uuid
        """,
        (user_id,),
    )
    r = cur.fetchone()
    return _user_row_to_dict(r) if r else None


def get_user_by_slug(cur, slug: str) -> dict | None:
    cur.execute("SELECT id FROM users WHERE slug = %s", (slug,))
    r = cur.fetchone()
    return get_user(cur, str(r[0])) if r else None


def create_user(
    cur, *,
    slug:        str,
    email:       str,
    name:        str  | None = None,
    output_lang: str          = "fr",
    active:      bool         = True,
    is_public:   bool         = False,
    plan:        str          = "demo",
) -> dict:
    """Insert a new row into `public.users`.

    Required fields:
      - `slug`  — unique kebab-case identifier. URL routes + legacy
        `config/users/<slug>/` paths key on this.
      - `email` — required so the Supabase Auth account (created
        separately via Dashboard) can be linked lazily at first login
        via email match. Without an email, the row is orphan-by-design.

    Optional with sensible defaults:
      - `name`        : display name (may stay null, slug is used as
                         fallback in the UI).
      - `output_lang` : default 'fr' (matches the column default).
      - `active`      : default TRUE.
      - `is_public`   : default FALSE (there are no public profiles).
      - `plan`        : default 'demo' (read-only). 'pro' to onboard a
                         paying user directly.

    NOT touched here:
      - `understood_languages` defaults to '{}' (column default), the
        admin can edit it later via PUT /admin/users/{id} once we
        surface that field (not in the UI yet).
      - `profile` defaults to NULL. The legacy JSON profiles populated
        this — fresh users don't need it.
      - `auth_id` is NULL until first login (matched by email).

    Idempotency / collision handling is the caller's job: the endpoint
    pre-checks slug + email uniqueness so it can surface a clean 409
    instead of bubbling up an IntegrityError.
    """
    cur.execute(
        """
        INSERT INTO users (slug, email, name, output_lang, active, is_public, plan)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (slug, email, name, output_lang, active, is_public, plan),
    )
    new_id = str(cur.fetchone()[0])
    result = get_user(cur, new_id)
    assert result is not None
    return result


def get_user_by_email(cur, email: str) -> dict | None:
    """Lookup helper used by the create endpoint to surface a clean 409
    when an admin tries to onboard a user whose email already exists."""
    cur.execute("SELECT id FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
    r = cur.fetchone()
    return get_user(cur, str(r[0])) if r else None


def update_user(
    cur, user_id: str, *,
    name:        str  | None = None,
    slug:        str  | None = None,
    email:       str  | None = None,
    output_lang: str  | None = None,
    active:      bool | None = None,
    is_public:   bool | None = None,
    plan:        str  | None = None,
) -> dict | None:
    """Patch-style update.

    Each kwarg is opt-in: pass only the fields you want to change. None
    means "leave alone" (we don't have "explicit-null" cases here — name
    can be empty string but never NULL).

    Caveats the admin should know (surfaced inline in the UI):
      - `slug` change breaks any `/users/{slug}/...` URL still cached in
        the wild and the legacy `config/users/<slug>/profile.json` file
        path. Use only on freshly-onboarded accounts.
      - `email` change does NOT propagate to Supabase Auth — the login
        identity stays whatever it was. This field is cosmetic /
        notification-only post-mismatch.
    """
    sets:   list[str] = []
    params: list[Any] = []
    if name        is not None: sets.append("name = %s");        params.append(name)
    if slug        is not None: sets.append("slug = %s");        params.append(slug)
    if email       is not None: sets.append("email = %s");       params.append(email)
    if output_lang is not None: sets.append("output_lang = %s"); params.append(output_lang)
    if active      is not None: sets.append("active = %s");      params.append(active)
    if is_public   is not None: sets.append("is_public = %s");   params.append(is_public)
    if plan        is not None: sets.append("plan = %s");        params.append(plan)
    if not sets:
        return get_user(cur, user_id)
    sets.append("updated_at = NOW()")
    params.append(user_id)
    cur.execute(
        f"UPDATE users SET {', '.join(sets)} WHERE id = %s::uuid",
        params,
    )
    if cur.rowcount == 0:
        return None
    return get_user(cur, user_id)
