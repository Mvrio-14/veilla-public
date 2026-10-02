"""How a fetched item becomes a row: pure parts only, no database."""
import json

from src.item_store import _row, canonical_key
from src.templates import FetchedItem


def test_nul_characters_never_reach_the_database() -> None:
    # Postgres refuses NUL in text, and in jsonb even as the `\u0000`
    # escape json.dumps produces — so they go before serialising.
    item = FetchedItem(
        url="https://example.org/a",
        title="Budget\x00 vote",
        summary="Sum\x00mary",
        authors=[{"name": "A\x00B"}],
        tags=["poli\x00tics"],
        raw={"title": "Budget\x00 vote"},
    )
    row = _row(item, source_id=None, fetched_at="2026-09-28T08:00:00+00:00")

    assert row["title"] == "Budget vote"
    assert row["summary"] == "Summary"
    for column in ("raw_entry", "authors", "tags"):
        assert "\\u0000" not in row[column]
    assert json.loads(row["authors"]) == [{"name": "AB"}]
    assert json.loads(row["tags"]) == ["politics"]


def test_row_carries_kind_and_source() -> None:
    item = FetchedItem(url="https://example.org/b", title="Two words", kind="article")
    row = _row(item, source_id=7, fetched_at="2026-09-28T08:00:00+00:00")
    assert (row["kind"], row["source_id"], row["raw_entry"]) == ("article", 7, "{}")


def test_canonical_key_groups_one_piece_published_twice_on_a_site() -> None:
    a = canonical_key("https://bfmtv.com/podcast/1", "Morning Briefing!", "2026-09-28T07:00:12+00:00")
    b = canonical_key("https://bfmtv.com/replay/2", "morning  briefing", "2026-09-28T07:00:48+00:00")
    other_site = canonical_key("https://lci.fr/x", "Morning Briefing", "2026-09-28T07:00:00+00:00")
    assert a == b == "content://bfmtv.com|2026-09-28T07:00||morning briefing"
    assert other_site != a


def test_canonical_key_is_unchanged_for_items_already_stored() -> None:
    # Existing rows are keyed this way: a new key would store them twice.
    assert canonical_key(
        "https://www.lemonde.fr/politique/article/1.html",
        "Budget 2027 : le gouvernement présente",
        "2026-09-28T06:00:00+00:00",
    ) == "content://www.lemonde.fr|2026-09-28T06:00||budget 2027 le gouvernement présente"


def test_canonical_key_falls_back_to_the_url_without_a_date() -> None:
    assert canonical_key("https://x.org/a?utm_source=rss", "Title", None).startswith("https://x.org/a")
