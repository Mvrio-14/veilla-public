"""
Monitor templates: how a monitor fetches.

Each template is a package here implementing `base.Template`, registered
below. The database stores a template's name without constraining it,
so adding one is a package and a line in TEMPLATES — no migration.

    rss          an RSS or Atom feed at a URL
    google_news  a Google News search, attributed item by item

A template is *how* items are fetched; what they are is their `kind`, and
the two do not depend on each other.
"""
from __future__ import annotations

from src.templates import google_news, rss
from src.templates.base import (
    FetchedItem,
    FetchError,
    FetchResult,
    Template,
    TemplateError,
)

TEMPLATES: dict[str, Template] = {
    t.name: t for t in (rss.TEMPLATE, google_news.TEMPLATE)
}

__all__ = [
    "TEMPLATES", "FetchedItem", "FetchError", "FetchResult", "Template",
    "TemplateError", "get_template", "prepare",
]


def get_template(name: str) -> Template:
    try:
        return TEMPLATES[name]
    except KeyError:
        raise TemplateError(
            f"Unknown template {name!r}; expected one of {sorted(TEMPLATES)}."
        ) from None


def prepare(template: str, config: dict) -> tuple[Template, dict, str]:
    """Validate a template and its config.

    Returns the template, the config as it should be stored, and its
    identity key. Raises TemplateError on anything unusable.
    """
    tpl = get_template(template)
    normalized = tpl.normalize(config)
    return tpl, normalized, tpl.identity_key(normalized)
