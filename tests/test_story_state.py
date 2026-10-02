"""The story_state call's input and output: pure parts, no model, no database."""
import json

import pytest

from src.story_state import Article, StoryInput, build_message, parse_response, sample_titles


def _story(**overrides) -> StoryInput:
    seed = Article(1, "EU blocks funds for Chinese solar parts", "The EU blocked funds.", "en", 10)
    new = [
        Article(2, "Commission targets Huawei solar tech", "Huawei named.", "fr", 11),
        Article(3, "EU stops financing Chinese inverters", "", "de", 12),
    ]
    fields = dict(
        story_id=42, label=None, synthesis=None, origin=None, timeline=[],
        titles=[seed, *new], seed=seed, new=new, pending_ids=[1, 2, 3],
    )
    fields.update(overrides)
    return StoryInput(**fields)


def _answer(**overrides) -> str:
    answer = {
        "themes": [{"name": "EU solar ban", "fits_n": 3}],
        "label": "EU funding ban on Chinese solar inverters",
        "synthesis": "Brussels suspended EU subsidies for projects using Chinese inverters.",
        "origin": "The EU blocked funding for projects using Chinese solar parts.",
        "notes": [{"article": "2", "note": "Huawei specifically targeted."}],
    }
    answer.update(overrides)
    return json.dumps(answer)


# ── Message ─────────────────────────────────────────────────────────────────
def test_a_new_story_sends_its_seed_and_the_articles_after_it() -> None:
    message = build_message(_story())
    assert "SEED:\n  title: [en] EU blocks funds for Chinese solar parts" in message
    assert "- id: 2\n  title: [fr] Commission targets Huawei solar tech\n  summary: Huawei named." in message
    assert "- id: 3\n  title: [de] EU stops financing Chinese inverters" in message
    assert "- id: 1" not in message          # the seed becomes the origin, not a note
    assert "label: (none)" in message


def test_a_known_story_sends_its_current_text_and_no_seed() -> None:
    message = build_message(_story(
        label="EU solar ban", synthesis="A sentence.", origin="How it began.",
        timeline=["Huawei named."], seed=None,
    ))
    assert "SEED:" not in message
    assert "origin: How it began." in message
    assert "timeline:\n    - Huawei named." in message


# ── Response ────────────────────────────────────────────────────────────────
def test_notes_are_kept_only_for_the_articles_of_the_call() -> None:
    state = parse_response(_answer(notes=[
        {"article": "2", "note": "Huawei specifically targeted."},
        {"article": "2", "note": "A second note for the same article."},
        {"article": "99", "note": "An article the model made up."},
        {"article": "1", "note": "The seed, already the origin."},
        {"article": "3", "note": "  "},
    ]), _story())
    assert state.notes == {2: "Huawei specifically targeted."}


def test_a_story_without_origin_must_get_one() -> None:
    with pytest.raises(ValueError, match="origin"):
        parse_response(_answer(origin=None), _story())


def test_an_origin_is_ignored_when_the_story_has_one() -> None:
    state = parse_response(_answer(origin="Rewritten."), _story(origin="How it began.", seed=None))
    assert state.origin is None


@pytest.mark.parametrize("field", ["label", "synthesis"])
def test_an_empty_label_or_synthesis_is_a_failure(field) -> None:
    with pytest.raises(ValueError):
        parse_response(_answer(**{field: " "}), _story())


# ── Sampling ────────────────────────────────────────────────────────────────
def test_titles_are_sampled_across_time_and_sources() -> None:
    # 40 articles in 4 periods; each period has one source that published
    # most of it and a second that published once.
    articles = []
    for period in range(4):
        base = period * 10
        articles += [Article(base + i, f"t{base + i}", source=f"main{period}") for i in range(9)]
        articles.append(Article(base + 9, f"t{base + 9}", source=f"other{period}"))
    sampled = sample_titles(articles, max_titles=8)

    assert len(sampled) == 8
    assert {a.id // 10 for a in sampled} == {0, 1, 2, 3}                  # every period
    assert {a.source for a in sampled} >= {f"other{p}" for p in range(4)}  # every source
