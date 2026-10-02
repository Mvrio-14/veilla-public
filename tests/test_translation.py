"""Translation: what is asked of the model, what is kept of its answer, and
what an English reader is shown. No model, no database."""
import json
from types import SimpleNamespace as NS

import pytest

from src import article_translator
from src.loaders.common import resolve_display_summary, resolve_display_title
from src.story_translator import Missing, build_message, parse_response


# ── Story texts ─────────────────────────────────────────────────────────────
def test_only_what_is_missing_is_sent() -> None:
    m = Missing(7, "fr", synthesis="A sentence.", updates={3: "Huawei named."})
    assert json.loads(build_message(m)) == {
        "synthesis": "A sentence.",
        "updates": [{"id": "3", "text": "Huawei named."}],
    }


def test_only_what_was_asked_for_is_kept() -> None:
    m = Missing(7, "fr", synthesis="A sentence.", updates={3: "Huawei named."})
    answer = json.dumps({
        "label": "Un titre qu'on n'a pas demandé",
        "synthesis": "Une phrase.",
        "origin": "",
        "updates": [{"id": "3", "text": "Huawei visé."}, {"id": "99", "text": "Inventé."}],
    })
    t = parse_response(answer, m)
    assert (t.label, t.synthesis, t.origin, t.updates) == (None, "Une phrase.", None, {3: "Huawei visé."})


# ── Article texts ───────────────────────────────────────────────────────────
def test_article_translations_are_matched_by_id(monkeypatch) -> None:
    answer = {"articles": [
        {"id": "2", "title": "Deuxième", "summary": "Résumé inventé"},
        {"id": "1", "title": "Premier", "summary": "Résumé"},
        {"id": "9", "title": "Inconnu", "summary": ""},
    ]}
    client = NS(chat=NS(completions=NS(create=lambda **kw: NS(
        choices=[NS(message=NS(content=json.dumps(answer)))],
        usage=NS(prompt_tokens=10, completion_tokens=5)))))
    batch = [{"id": 1, "title": "First", "summary": "Summary"},
             {"id": 2, "title": "Second", "summary": ""}]
    out, *_ = article_translator._translate(batch, "fr", client)
    # An article sent without a summary gets none back, whatever the model wrote.
    assert out == {1: ("Premier", "Résumé"), 2: ("Deuxième", "")}


# ── What an English reader sees ─────────────────────────────────────────────
ARTICLE = {
    "lang": "fr",
    "title": "Le budget est adopté",
    "title_normalized": "Budget adopted",
    "summary": "Résumé.",
    "summary_normalized": "Summary.",
    "title_for_user_lang": None,
    "summary_for_user_lang": None,
}


@pytest.mark.parametrize("resolve, expected", [
    (resolve_display_title, ("Budget adopted", True)),
    (resolve_display_summary, ("Summary.", True)),
])
def test_an_english_reader_reads_the_normalised_text_as_a_translation(resolve, expected) -> None:
    assert resolve(ARTICLE, "en") == expected


def test_a_reader_of_the_source_language_reads_the_original() -> None:
    assert resolve_display_title(ARTICLE, "fr") == ("Le budget est adopté", False)


def test_another_reader_waits_for_a_translation_and_falls_back_to_english() -> None:
    assert resolve_display_title(ARTICLE, "de") == ("Budget adopted", False)
    translated = {**ARTICLE, "title_for_user_lang": "Haushalt verabschiedet"}
    assert resolve_display_title(translated, "de") == ("Haushalt verabschiedet", True)
