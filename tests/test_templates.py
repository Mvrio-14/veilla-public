"""The templates, fetched against recorded feeds: no network, no database."""
from pathlib import Path

import pytest
import requests

from src.templates import FetchError, TemplateError, prepare, rss
from src.templates import google_news as gn

FIXTURES = Path(__file__).parent / "fixtures"


class FakeResponse:
    def __init__(self, body=b"", status=200, headers=None, url="", history=()):
        self._body = body
        self.status_code = status
        self.headers = headers or {}
        self.url = url
        self.history = list(history)

    def iter_content(self, chunk_size):
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i:i + chunk_size]

    def close(self):
        pass


@pytest.fixture
def serve(monkeypatch):
    """Make `requests.get` answer with the given response, and record the
    headers each request sent."""
    sent = []

    def install(response):
        def fake_get(url, headers=None, **kwargs):
            sent.append(headers or {})
            if isinstance(response, Exception):
                raise response
            if not response.url:
                response.url = url
            return response
        monkeypatch.setattr(rss.requests, "get", fake_get)
        return sent
    return install


# ── Registry ────────────────────────────────────────────────────────────────
def test_prepare_validates_and_derives_the_identity() -> None:
    _, config, key = prepare("rss", {"url": " https://x.org/feed.xml "})
    assert config == {"url": "https://x.org/feed.xml"}
    assert key == "rss:https://x.org/feed.xml"

    _, config, key = prepare("google_news", {"query": "Novartis", "hl": "FR", "gl": "fr"})
    assert (config["hl"], config["gl"], config["ceid"]) == ("fr", "FR", "FR:fr")
    assert key == f"google_news:{config['url']}"


@pytest.mark.parametrize("template, config", [
    ("rss", {"url": "ftp://x.org/feed"}),
    ("google_news", {"query": "  "}),
    ("scraper", {}),
])
def test_prepare_refuses_what_cannot_be_fetched(template, config) -> None:
    with pytest.raises(TemplateError):
        prepare(template, config)


# ── RSS ─────────────────────────────────────────────────────────────────────
def test_rss_fetch_turns_entries_into_items(serve) -> None:
    serve(FakeResponse((FIXTURES / "lemonde.xml").read_bytes(), headers={"ETag": '"v1"'}))
    result = rss.TEMPLATE.fetch({"url": "https://www.lemonde.fr/rss/une.xml"}, {})

    assert [i.title for i in result.items] == [
        "Budget 2027 : le gouvernement présente un succès",   # entity decoded
        "Grève dans les transports",
    ]                                                        # no link: dropped
    budget = result.items[0]
    assert budget.summary == "Le projet de loi de finances est présenté ce lundi."
    assert budget.published_at.startswith("2026-09-28T06:00:00")
    assert budget.image_url == "https://img.lemonde.fr/budget.jpg"
    assert budget.tags == ["Politique"]
    assert budget.source_domain is None          # the monitor's source applies
    assert result.cursor == {"etag": '"v1"'}
    assert any("'frobnicate'" in w for w in result.warnings)
    assert not any("surtitre" in w for w in result.warnings)


def test_rss_sends_the_cursor_back_and_honours_304(serve) -> None:
    sent = serve(FakeResponse(status=304, headers={"ETag": '"v1"'}))
    result = rss.TEMPLATE.fetch(
        {"url": "https://x.org/feed.xml"},
        {"etag": '"v1"', "last_modified": "Mon, 28 Sep 2026 06:00:00 GMT"},
    )
    assert sent[0]["If-None-Match"] == '"v1"'
    assert sent[0]["If-Modified-Since"] == "Mon, 28 Sep 2026 06:00:00 GMT"
    assert result.not_modified and result.items == []
    assert result.cursor["etag"] == '"v1"'


def test_an_empty_feed_is_a_successful_fetch(serve) -> None:
    # Served with a content type feedparser dislikes, which sets `bozo`:
    # still a feed, just one with nothing in it today.
    body = b'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>'
    serve(FakeResponse(body, headers={"Content-Type": "text/html; charset=latin-1"}))
    result = rss.TEMPLATE.fetch({"url": "https://x.org/feed.xml"}, {})
    assert result.items == [] and not result.not_modified


@pytest.mark.parametrize("response, message", [
    (FakeResponse(status=404), "HTTP 404"),
    (FakeResponse(b"<html><body>not a feed</body></html>"), "not a feed"),
    (requests.ConnectionError("refused"), "network: ConnectionError"),
])
def test_rss_failures_are_fetch_errors(serve, response, message) -> None:
    serve(response)
    with pytest.raises(FetchError, match=message):
        rss.TEMPLATE.fetch({"url": "https://x.org/feed.xml"}, {})


def test_rss_moves_after_the_same_redirect_three_times(serve) -> None:
    config = {"url": "https://x.org/old.xml"}
    moved = FakeResponse(status=304, url="https://x.org/new.xml", history=[object()])
    serve(moved)

    cursor = {}
    for expected_count in (1, 2):
        result = rss.TEMPLATE.fetch(config, cursor)
        assert result.new_config is None
        assert result.cursor["redirect_seen_count"] == expected_count
        cursor = result.cursor
    result = rss.TEMPLATE.fetch(config, cursor)
    assert result.new_config == {"url": "https://x.org/new.xml"}
    assert "redirect_url" not in result.cursor


def test_rss_redirect_count_restarts_when_the_target_changes(serve) -> None:
    serve(FakeResponse(status=304, url="https://x.org/b.xml", history=[object()]))
    cursor = {"redirect_url": "https://x.org/a.xml", "redirect_seen_count": 2}
    result = rss.TEMPLATE.fetch({"url": "https://x.org/old.xml"}, cursor)
    assert result.cursor["redirect_seen_count"] == 1
    assert result.new_config is None


# ── Google News ─────────────────────────────────────────────────────────────
def test_google_news_attributes_each_item_to_its_outlet(serve) -> None:
    serve(FakeResponse((FIXTURES / "google_news.xml").read_bytes()))
    config = gn.TEMPLATE.normalize({"query": "Novartis"})
    result = gn.TEMPLATE.fetch(config, {})

    assert [(i.source_name, i.source_domain) for i in result.items] == [
        ("Les Echos", "lesechos.fr"),
        ("Reuters", "reuters.com"),
    ]
    # The outlet's name is dropped from the title, and only that: a title
    # with a dash of its own keeps it.
    assert [i.title for i in result.items] == [
        "Novartis rachète une biotech américaine",
        "Bâle - Zurich : Novartis réorganise sa recherche",
    ]
    # The article on the outlet's site, not Google's redirect.
    assert result.items[0].url == (
        "https://www.lesechos.fr/industrie-services/pharmacie-sante/"
        "novartis-rachete-une-biotech-2192735"
    )


def test_google_news_never_asks_to_move(serve) -> None:
    serve(FakeResponse(status=304, url="https://news.google.com/elsewhere", history=[object()]))
    config = gn.TEMPLATE.normalize({"query": "Novartis"})
    cursor = {}
    for _ in range(4):
        result = gn.TEMPLATE.fetch(config, cursor)
        assert result.new_config is None
        assert "redirect_url" not in result.cursor
        cursor = result.cursor


@pytest.mark.parametrize("title, publisher, expected", [
    ("Budget adopted - Le Monde", "Le Monde", "Budget adopted"),
    ("Budget adopted – le monde", "Le Monde", "Budget adopted"),
    ("Budget adopted - Le Monde", "Reuters", "Budget adopted - Le Monde"),
    ("Le Monde", "Le Monde", "Le Monde"),
    ("Budget adopted", None, "Budget adopted"),
])
def test_strip_publisher(title, publisher, expected) -> None:
    assert gn.strip_publisher(title, publisher) == expected
