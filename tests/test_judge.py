"""The judge: what a watcher is asked, what is kept of its answer, and how
verdicts are grouped for the Decisions screen. No model, no database."""
import json
from datetime import datetime, timedelta, timezone

import pytest

from src.judge import (
    STALE_HOURS,
    Article,
    Moment,
    Pending,
    Watcher,
    build_message,
    parse_response,
    plan,
)
from src.signal import group_moments

NOW = datetime(2026, 9, 29, 12, 0, tzinfo=timezone.utc)
WATCHER = Watcher(id=1, user_id="u", request="Decarbonisation decisions, no op-eds.",
                  context="Economics desk, northern France.", lang="fr", monitors=[10],
                  created_at=NOW - timedelta(days=1))
ARTICLES = [
    Article(3, "ArcelorMittal commits 1.2 billion to Dunkirk", "The EU approved 850 million in state aid.",
            "Les Echos", "https://ex.org/3"),
    Article(2, "Dunkirk furnace approved", "", "Reuters", "https://ex.org/2"),
]


def moment(**kw) -> Moment:
    return Moment(WATCHER, 7, "Dunkirk electric furnace", "ArcelorMittal confirms the furnace.",
                  ARTICLES, [3, 2], **kw)


# ── What is sent ────────────────────────────────────────────────────────────
def test_the_message_carries_context_request_story_and_new_articles() -> None:
    msg = build_message(moment())
    for part in ("Economics desk", "no op-eds", "Dunkirk electric furnace",
                 "commits 1.2 billion", "source: Reuters"):
        assert part in msg
    assert "ALREADY KEPT" not in msg


def test_an_earlier_keep_is_sent_with_its_reason() -> None:
    assert "ALREADY KEPT:\nState aid approved." in build_message(moment(already_kept="State aid approved."))


# ── What is kept ────────────────────────────────────────────────────────────
def answer(**kw) -> str:
    return json.dumps({"verdict": "kept", "reason": "Aide d'État validée.", "excerpt": "", **kw})


def test_a_verdict_and_its_reason_are_kept() -> None:
    j = parse_response(answer(excerpt="approved 850 million in state aid"), moment())
    assert (j.verdict, j.reason, j.excerpt) == ("kept", "Aide d'État validée.",
                                                 "approved 850 million in state aid")


def test_an_excerpt_the_articles_do_not_contain_is_dropped() -> None:
    assert parse_response(answer(excerpt="a sentence nobody wrote"), moment()).excerpt is None


@pytest.mark.parametrize("bad", [{"verdict": "maybe"}, {"reason": "  "}])
def test_an_unusable_answer_raises_so_the_articles_are_judged_again(bad) -> None:
    with pytest.raises(ValueError):
        parse_response(answer(**bad), moment())


# ── What is judged now ──────────────────────────────────────────────────────
def pending(story, hours_ago) -> Pending:
    return Pending(story, [story * 10], NOW - timedelta(hours=hours_ago))


def test_the_budget_takes_the_newest_and_the_rest_waits_while_fresh() -> None:
    judge, skip = plan([pending(1, 0.1), pending(2, 1), pending(3, 3)], budget=1, now=NOW)
    assert [p.story_id for p in judge] == [1]
    assert skip == []


def test_a_story_the_budget_cannot_reach_is_skipped_once_stale() -> None:
    judge, skip = plan([pending(1, 0.1), pending(2, STALE_HOURS + 1)], budget=1, now=NOW)
    assert [p.story_id for p in judge] == [1]
    assert [p.story_id for p in skip] == [2]


def test_a_spent_budget_judges_nothing() -> None:
    judge, skip = plan([pending(1, 0.1)], budget=-3, now=NOW)
    assert judge == [] and skip == []


# ── Decisions ───────────────────────────────────────────────────────────────
PASS_1 = datetime(2026, 9, 29, 9, 0, tzinfo=timezone.utc)
PASS_2 = datetime(2026, 9, 29, 10, 0, tzinfo=timezone.utc)


def row(jid, watcher, story, pass_at, verdict="dropped"):
    inp = {"label": f"story {story}", "synthesis": "", "already_kept": None,
           "articles": [{"title": "t", "source": "s", "url": f"https://ex.org/{story}"}]}
    return (jid, watcher, story, pass_at, verdict, "r", None, inp, "m", 100, 10, pass_at, None)


def test_verdicts_on_one_story_in_one_pass_form_one_moment() -> None:
    moments = group_moments([row(5, 1, 7, PASS_1, "kept"), row(4, 2, 7, PASS_1)],
                            scopes={1: {10}, 2: {10}}, story_monitors={7: {10}})
    assert len(moments) == 1
    m = moments[0]
    assert m["id"] == 4 and m["label"] == "story 7" and len(m["articles"]) == 1
    assert sorted(d["watcher_id"] for d in m["decisions"]) == [1, 2]
    assert m["not_judged"] == []


def test_a_watcher_that_did_not_judge_says_why() -> None:
    [m] = group_moments([row(1, 1, 7, PASS_1)],
                        scopes={1: {10}, 2: {10}, 3: {99}}, story_monitors={7: {10}})
    assert {(n["watcher_id"], n["reason"]) for n in m["not_judged"]} == {
        (2, "pending"), (3, "out_of_scope")}


def test_a_watcher_that_judged_the_story_on_another_pass_is_not_waiting() -> None:
    moments = group_moments([row(2, 2, 7, PASS_2), row(1, 1, 7, PASS_1)],
                            scopes={1: {10}, 2: {10}}, story_monitors={7: {10}})
    assert [m["at"] for m in moments] == [PASS_2.isoformat(), PASS_1.isoformat()]
    assert all(m["not_judged"] == [] for m in moments)


def test_a_skipped_story_is_listed_as_not_judged_for_budget() -> None:
    [m] = group_moments([row(2, 1, 7, PASS_1, "skipped"), row(1, 2, 7, PASS_1)],
                        scopes={1: {10}, 2: {10}}, story_monitors={7: {10}})
    assert [d["watcher_id"] for d in m["decisions"]] == [2]
    assert m["not_judged"] == [{"watcher_id": 1, "reason": "budget"}]
