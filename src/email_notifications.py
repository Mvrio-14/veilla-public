"""
Email channel for notifications.

Called by `src.notifications.emit` when the recipient's `notif_prefs`
have email turned on for the notification's type group. We:

  1. Look up the recipient's email + display name.
  2. Render a type-specific HTML+text template using the notification's
     payload (which carries enough context to be self-contained).
  3. POST to Resend's API via the `resend` SDK.

Failures are swallowed and logged — the in-app notification has
already landed, a Resend hiccup must not block the worker pass.

# Env

  - RESEND_API_KEY  : required for actual delivery. When missing, send
                      is silently skipped (= dev mode without Resend).
  - WEBAPP_URL      : frontend origin used in deep-links (default
                      https://veilla.io). Override for staging.
  - NOTIF_FROM      : sender address (default "Veilla <noreply@veilla.io>").

# Templates

One template per notification type. Each returns:
  {"subject": str, "html": str, "text": str}

HTML is intentionally tiny — inline styles, no remote assets, no
analytics pixel. Plain text mirrors the HTML for clients that strip
markup. Templates carry a footer with a "Manage notifications" link
(Settings → Notifications) so users can opt out without contacting us.
"""
from __future__ import annotations

import os
from html import escape

try:
    import resend  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover
    resend = None  # type: ignore[assignment]


# ── Config ──────────────────────────────────────────────────────────────────
WEBAPP_URL = (os.environ.get("WEBAPP_URL") or "https://veilla.io").rstrip("/")
NOTIF_FROM = os.environ.get("NOTIF_FROM") or "Veilla <noreply@veilla.io>"


def _resend_ready() -> bool:
    """True when the SDK is importable AND an API key is configured.
    Worker can run without Resend (the email channel is OFF by default
    for everything except story_follow); this gates each call so we
    skip silently instead of crashing the pass."""
    if resend is None:
        return False
    key = os.environ.get("RESEND_API_KEY")
    if not key:
        return False
    resend.api_key = key
    return True


# ── Recipient lookup ────────────────────────────────────────────────────────
def _load_recipient(conn, user_id: str) -> dict | None:
    """Email + slug + display name + lang for the recipient. Returns
    None when the user has no email on file (= solo test account,
    anon, etc.).

    `lang` is normalized to "fr" or "en" — every other locale falls
    back to "en" (we don't translate emails into more languages yet).
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT email, slug, profile, output_lang FROM users WHERE id = %s",
        (user_id,),
    )
    row = cur.fetchone()
    if not row:
        return None
    email, slug, profile_raw, output_lang = row
    if not email:
        return None
    import json
    profile = profile_raw if isinstance(profile_raw, dict) else json.loads(profile_raw or "{}")
    raw_lang = (output_lang or "en").lower().split("-")[0]
    lang = "fr" if raw_lang == "fr" else "en"
    return {
        "email": email,
        "slug": slug,
        "display": profile.get("name") or slug or email,
        "lang": lang,
    }


def _l(lang: str, en: str, fr: str) -> str:
    """Inline localizer used inside email template strings.
    `lang` is already normalized to "fr" or "en" by `_load_recipient`."""
    return fr if lang == "fr" else en


# ── Templates ───────────────────────────────────────────────────────────────
def _watch_url(story_id: int | None = None) -> str:
    base = f"{WEBAPP_URL}/watch"
    if story_id is None:
        return base
    return f"{base}?story={story_id}"


def _notif_settings_url() -> str:
    return f"{WEBAPP_URL}/settings/notifications"


def _shell(*, lang: str, title: str, body_html: str, body_text: str,
           cta_href: str, cta_label: str) -> dict:
    """Render the shared visual frame around a per-type body block.

    All templates use the same compact card-style layout: title at the
    top, a free-form body block in the middle (single CTA inline), and
    a thin footer with the inbox + settings links. Kept intentionally
    minimal (no images, no tables, no responsive grid) so little time
    goes into email template engineering.

    `lang` controls the footer label only — body content is already
    localized by the caller. Currently `"fr"` or `"en"`; any other
    value falls back to en."""
    manage_label = _l(lang, "Manage notifications", "Gérer les notifications")
    safe_title = escape(title)
    html = (
        f"<!doctype html><html><body style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;max-width:520px;margin:0 auto;padding:24px;\">"
        f"<h2 style=\"font-size:18px;margin:0 0 14px;font-weight:600;\">{safe_title}</h2>"
        f"<div style=\"font-size:14px;line-height:1.55;color:#333;\">{body_html}</div>"
        f"<p style=\"margin:20px 0 8px;\"><a href=\"{escape(cta_href)}\" style=\"display:inline-block;background:#111;color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px;font-weight:500;\">{escape(cta_label)}</a></p>"
        f"<hr style=\"border:none;border-top:1px solid #eee;margin:28px 0 12px;\"/>"
        f"<p style=\"font-size:11px;color:#777;margin:0;\">— Veilla · "
        f"<a href=\"{escape(_notif_settings_url())}\" style=\"color:#777;\">{escape(manage_label)}</a></p>"
        f"</body></html>"
    )
    text = (
        f"{title}\n\n"
        f"{body_text}\n\n"
        f"{cta_label}: {cta_href}\n\n"
        f"— Veilla\n"
        f"{manage_label}: {_notif_settings_url()}\n"
    )
    return {"subject": title, "html": html, "text": text}


def _template_story_update(payload: dict, lang: str) -> dict:
    fallback_title = _l(lang, "A story you follow", "Une story que tu suis")
    story_title    = payload.get("story_title") or fallback_title
    kind           = payload.get("kind")
    article_title  = payload.get("article_title")
    update_text    = payload.get("update_text")
    source         = payload.get("source")
    story_id       = payload.get("story_id")

    if kind == "new_article" and article_title:
        subject = _l(lang,
            f"New article on \"{story_title}\"",
            f"Nouvel article sur « {story_title} »")
        footer = _l(lang,
            "A new article landed in this story you follow.",
            "Un nouvel article est arrivé sur une story que tu suis.")
        body_h = (
            f"<p><strong>{escape(article_title)}</strong>"
            + (f" · <span style=\"color:#666;\">{escape(source)}</span>" if source else "")
            + f"</p>"
            f"<p style=\"color:#555;\">{escape(footer)}</p>"
        )
        body_t = (
            f"{article_title}"
            + (f" — {source}" if source else "")
            + f"\n\n{footer}"
        )
    elif kind == "new_update" and update_text:
        subject = _l(lang,
            f"Update on \"{story_title}\"",
            f"Mise à jour sur « {story_title} »")
        footer = _l(lang,
            "New development on this story you follow.",
            "Nouvelle évolution sur une story que tu suis.")
        body_h = (
            f"<p style=\"background:#f6f6f6;border-left:3px solid #2563eb;padding:10px 12px;margin:0 0 12px;\">"
            f"{escape(update_text)}</p>"
            f"<p style=\"color:#555;\">{escape(footer)}</p>"
        )
        body_t = f"\"{update_text}\"\n\n{footer}"
    else:
        subject = _l(lang,
            f"Update on \"{story_title}\"",
            f"Mise à jour sur « {story_title} »")
        body = _l(lang,
            "New activity on this story you follow.",
            "Nouvelle activité sur une story que tu suis.")
        body_h = f"<p style=\"color:#555;\">{escape(body)}</p>"
        body_t = body

    return _shell(
        lang=lang,
        title=subject,
        body_html=body_h,
        body_text=body_t,
        cta_href=_watch_url(story_id) if story_id else _watch_url(),
        cta_label=_l(lang, "Open in Veilla", "Ouvrir dans Veilla"),
    )


_TEMPLATES = {
    "story_update":       _template_story_update,
}


# ── Public entry ────────────────────────────────────────────────────────────
def send_async(conn, user_id: str, type: str, payload: dict) -> None:
    """Render and ship the email for one notification. Fire-and-forget.

    Caller is `src.notifications.emit`. We don't await anything — Resend
    HTTP is fast enough at current volume that an inline call is acceptable
    (sub-second). If Resend becomes a bottleneck later, wrap this body
    in a ThreadPoolExecutor.submit() or move to a queue worker.

    Silently no-ops when:
      - the `resend` SDK isn't importable
      - RESEND_API_KEY isn't set (dev mode without email)
      - the recipient has no email on file
      - the notification `type` has no registered template
    """
    if not _resend_ready():
        return

    template_fn = _TEMPLATES.get(type)
    if template_fn is None:
        print(f"[email] no template for notification type {type!r}")
        return

    recipient = _load_recipient(conn, user_id)
    if recipient is None:
        return

    try:
        rendered = template_fn(payload, recipient["lang"])
    except Exception as e:
        print(f"[email] template render failed type={type} user={user_id}: "
              f"{type(e).__name__}: {e}", flush=True)
        return

    try:
        result = resend.Emails.send({  # type: ignore[union-attr]
            "from":    NOTIF_FROM,
            "to":      [recipient["email"]],
            "subject": rendered["subject"],
            "html":    rendered["html"],
            "text":    rendered["text"],
        })
        rid = result.get("id", "?") if isinstance(result, dict) else "?"
        print(f"[email] sent type={type} to={recipient['email']} id={rid}",
              flush=True)
    except Exception as e:
        # All Resend failure modes (network, 4xx, 5xx) collapse here.
        # The in-app notif already landed; we lose the email and log.
        print(f"[email] send failed type={type} user={user_id}: "
              f"{type(e).__name__}: {e}", flush=True)
