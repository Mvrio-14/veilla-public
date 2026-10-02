"""
The contract every template fulfils.

A template knows three things about one way of fetching:

  - which configs are valid, and how they are stored (`normalize`);
  - when two configs are the same thing to fetch (`identity_key`);
  - how to fetch, from where the previous fetch left off (`fetch`).

`fetch` touches the network and nothing else. It gets a monitor's config
and cursor and returns what it found as `FetchedItem`s, in one shape
whatever the source, with the cursor to resume from. Storing items,
counting failures and moving a monitor to a new config are the
collector's job, the same for every template.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


class TemplateError(ValueError):
    """A template name or config that cannot be used."""


class FetchError(Exception):
    """A fetch that failed. The message says why, and is what the monitor's
    health and its run history record."""


@dataclass
class FetchedItem:
    """One thing a monitor brought back, before it is stored.

    Text fields are as the source gave them, cleaned of markup. The
    collector derives everything else — deduplication key, publisher
    row, whether it is old backlog — the same way for every template.
    """
    url:          str
    title:        str
    published_at: str | None = None     # ISO 8601
    updated_at:   str | None = None
    summary:      str | None = None
    content:      str | None = None
    content_type: str | None = None
    author:       str | None = None
    authors:      list | None = None
    tags:         list | None = None
    image_url:    str | None = None
    guid:         str | None = None
    # The publisher, when the template can tell it apart from the monitor's
    # own (a Google News result names the outlet it comes from). Left
    # empty, the item is attributed to the monitor's source.
    source_domain: str | None = None
    source_name:   str | None = None
    kind:         str = "article"
    # The entry as received, kept for debugging and for fields not mapped yet.
    raw:          dict[str, Any] = field(default_factory=dict)


@dataclass
class FetchResult:
    items:        list[FetchedItem]
    # Where the next fetch resumes. Replaces the monitor's cursor.
    cursor:       dict[str, Any]
    # Nothing new since the cursor: the source said so (an HTTP 304).
    not_modified: bool = False
    # The config the monitor should move to, when the source has moved
    # for good (a feed permanently redirected). The collector applies it.
    new_config:   dict[str, Any] | None = None
    # Worth a line in the logs, not a failure: unmapped fields, a field
    # that is always empty.
    warnings:     list[str] = field(default_factory=list)


class Template(ABC):
    name:         str
    # The coarse transport, one of the values the schema accepts.
    fetch_method: str
    # What its items are.
    kind:         str = "article"

    @abstractmethod
    def normalize(self, config: dict) -> dict:
        """The config as stored: validated, normalised, derived fields set.
        Raises TemplateError."""

    @abstractmethod
    def identity_key(self, config: dict) -> str:
        """What makes two monitors the same thing to fetch. Two public
        monitors never share one, which is what lets every follower of a
        feed share a single fetch."""

    @abstractmethod
    def fetch(self, config: dict, cursor: dict) -> FetchResult:
        """Fetch from where `cursor` left off. Raises FetchError."""

    def preview(self, config: dict) -> FetchResult:
        """What the template finds for a config nobody has fetched yet.
        Used before a catalogue entry is saved."""
        return self.fetch(self.normalize(config), {})
