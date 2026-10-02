"""
Admin field validators — country, language, slug, etc.

Each raises `ValueError` with a clear message on bad input. The endpoint
handler catches and re-raises as HTTPException(400) so the SPA can show
the message inline next to the offending field.

# Country (sources.country)

A valid country is one of:
  - An ISO 3166-1 alpha-2 code (`FR`, `US`, `JP`, ...) — full list in
    `src.taxonomy.VALID_COUNTRY_CODES` (the only place we accept).
  - One of the 6 regional codes (`EUR`, `MID`, `ASI`, `AFR`, `LAT`, `OCE`).
  - `GLB` (= global, no specific country).

# Language (catalog.country — historical misnomer)

We accept any 2-letter lowercase ISO 639-1 code from a curated whitelist
that covers every lang we've ever seen in production. The whitelist is
intentionally explicit (rather than `^[a-z]{2}$` shape-only) so that
typos like `enn`, `fra`, `xz` are rejected immediately rather than
silently appearing as a brand-new lang downstream.

If the worker ever fetches a feed in a lang we don't have on the
whitelist, the admin adds the 2-letter code here in one PR — surfaces
the question instead of hiding it.
"""
from __future__ import annotations

from src.taxonomy import REGIONAL_CODES, VALID_COUNTRY_CODES

# ── Country (publisher origin) ───────────────────────────────────────────
_ALLOWED_COUNTRIES: frozenset[str] = frozenset(
    set(VALID_COUNTRY_CODES) | set(REGIONAL_CODES) | {"GLB"}
)


def validate_country(code: str | None) -> str | None:
    """Normalize + validate a country / regional code. Empty → None.

    Returns the uppercased code, or None when the input is empty/None.
    Raises ValueError with the offending value when the code is invalid.
    """
    if code is None:
        return None
    s = code.strip().upper()
    if not s:
        return None
    if s not in _ALLOWED_COUNTRIES:
        raise ValueError(
            f"Invalid country code {s!r} — expected ISO 3166-1 alpha-2 "
            f"(FR, US, ...), a regional code (EUR, MID, ASI, AFR, LAT, OCE), "
            f"or GLB."
        )
    return s


# ── Language (feed content) ──────────────────────────────────────────────
# Curated whitelist of 2-letter ISO 639-1 codes we currently accept.
# This is intentionally finite — adding a new lang means adding it here
# (one-line PR) which surfaces "we now ingest a new language" instead of
# hiding it. The set covers every language in the catalogue; extend on
# demand.
_ALLOWED_LANGS: frozenset[str] = frozenset({
    # Western European
    "fr", "en", "de", "es", "it", "pt", "nl", "sv", "no", "da", "fi", "is",
    # Central / Eastern European
    "pl", "cs", "sk", "hu", "ro", "bg", "el", "hr", "sr", "sl", "et", "lv",
    "lt", "uk", "be", "ru",
    # Middle East
    "ar", "he", "fa", "tr",
    # Asian
    "zh", "ja", "ko", "vi", "th", "id", "ms", "hi", "bn", "ta", "ur",
    # African
    "sw", "af",
    # Other
    "ga", "cy", "eu", "ca", "gl",
})


def validate_lang(code: str | None) -> str | None:
    """Normalize + validate a language code. Empty → None.

    Returns the lowercased code on success, raises ValueError otherwise.
    """
    if code is None:
        return None
    s = code.strip().lower()
    if not s:
        return None
    if s not in _ALLOWED_LANGS:
        raise ValueError(
            f"Invalid language code {s!r} — expected a 2-letter ISO 639-1 "
            f"code from the whitelist (fr, en, de, es, it, pt, nl, ...). "
            f"To add a new lang, extend `_ALLOWED_LANGS` in "
            f"`src/admin/validation.py`."
        )
    return s


# ── Slug ────────────────────────────────────────────────────────────────
_SLUG_OK_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-_")


def validate_slug(slug: str | None) -> str | None:
    """Normalize + validate a feed/user slug. Empty → None.

    Slugs are URL-safe identifiers — lowercase ascii letters, digits,
    hyphens, underscores. Anything else gets rejected so a typo in the
    admin form doesn't end up as a URL-breaking slug in the catalog.
    """
    if slug is None:
        return None
    s = slug.strip()
    if not s:
        return None
    s_lower = s.lower()
    bad = [c for c in s_lower if c not in _SLUG_OK_CHARS]
    if bad:
        raise ValueError(
            f"Invalid slug {s!r} — only lowercase ascii letters, digits, "
            f"hyphens and underscores allowed. Bad characters: "
            f"{''.join(sorted(set(bad)))}."
        )
    return s_lower


# ── Email ───────────────────────────────────────────────────────────────
# Intentionally permissive — we accept anything that looks "email-shaped"
# rather than running RFC 5321. The admin is editing a display/notification
# email, not a security boundary; aggressive validation just blocks weird
# but valid addresses (e.g. `+tag@`, multi-dot domains).
import re as _re

_EMAIL_RE = _re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_email(email: str | None) -> str | None:
    """Normalize + minimally validate an email. Empty → None.

    Lowercases the address (consistent with how `users.email` is matched
    in the auth flow — case-insensitive). Raises ValueError on shapes
    that aren't even close to email-like.
    """
    if email is None:
        return None
    s = email.strip().lower()
    if not s:
        return None
    if not _EMAIL_RE.match(s):
        raise ValueError(
            f"Invalid email {s!r} — expected something matching "
            f"`local@host.tld`. Editing `public.users.email` does NOT "
            f"change the Supabase Auth login email; this is cosmetic."
        )
    return s
