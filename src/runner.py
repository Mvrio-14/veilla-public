"""
The ingest worker: one pass of the pipeline, then sleep, forever.

A pass runs collect -> normalize -> extract -> resolve entities -> embed
-> cluster -> story state -> judge -> translate -> notify. Each step is
isolated, so a transient failure in one (an OpenAI 429, a feed timing
out) is logged and reported without skipping the others. It runs as its
own process (`python -m src.runner`), separate from the API: the worker
never serves a request, and the API never calls a model.
"""
import argparse
import sys
import time
import traceback
from contextlib import ExitStack
from datetime import datetime, timezone

from openai import OpenAI

from src.article_translator import refresh_article_translations
from src.clusterer import cluster_pending
from src.collector import collect_and_store
from src.db import get_direct_connection
from src.embedder import embed_pending
from src.entity_resolver import (
    refresh_stale_entities,
)
from src.entity_resolver import (
    resolve_pending as resolve_entities_pending,
)
from src.extractor import extract_pending
from src.judge import judge_pending
from src.languages import PIPELINE_LANGUAGE
from src.monitors import get_user_monitor_ids, get_worker_fetch_set
from src.normalizer import normalize_pending
from src.observability import (
    capture_fatal,
    capture_step_failure,
    init_sentry,
    step_timer,
    worker_pass,
)
from src.realtime_broadcast import (
    broadcast_new_articles_to_user,
    broadcast_worker_heartbeat,
)
from src.story_state import refresh_story_states
from src.story_translator import refresh_story_translations

# How long to sleep between successful passes. Short enough that breaking
# news arrives within minutes; long enough not to hammer feeds for
# nothing. A pass takes two to three minutes, so this gives about ten
# minutes per cycle — six an hour, within the politeness range of the
# big aggregators without flooding small publishers.
SLEEP_AFTER_SUCCESS = 500  # ~8 minutes

# How long to sleep after an iteration that hit an unexpected error
# (likely a transient infra issue — DB connection, OpenAI rate limit, etc.).
# Longer than the success interval to avoid amplifying outages.
SLEEP_AFTER_ERROR = 120  # 2 minutes after a step error
SLEEP_AFTER_FATAL = 600  # 10 minutes after a fatal pass error

# Postgres advisory-lock key guarding a single pass. Render runs one
# worker instance, but a deploy/restart can briefly overlap the old and
# new instance — without this guard they'd both ingest the same articles,
# producing duplicate story_updates and double OpenAI billing. Arbitrary
# stable bigint; only this module uses it.
WORKER_PASS_LOCK_KEY = 8470011


def _handle_step_error(conn, step: str, e: Exception, stats: dict) -> None:
    """Centralised handler for a worker-step exception.

    Critical: rolls back the shared `conn` so the next step does NOT
    inherit a transaction in 'aborted' state. Without this, a single
    SQL error mid-step poisons every subsequent step of the pass (and
    even subsequent passes — psycopg2 returns the same conn from the
    pool, the pre-ping rollback at borrow only fires between borrows,
    not while the conn is currently held).

    Captured Sentry symptom: cascade of `InFailedSqlTransaction(
    'current transaction is aborted, commands ignored until end of
    transaction block')` on every step downstream of the first failure.

    Also pushes the full exception with traceback to Sentry (in
    addition to the message-only `capture_step_failure` aggregated at
    the end of the pass) so the stack trace is one click away in the
    issue detail. Tag with `pipeline_step` so Sentry groups events the
    same way as the summary message.
    """
    stats["step_errors"].append((step, repr(e)))
    print(f"[worker]   [ERROR] {step}: {type(e).__name__}: {e}")
    traceback.print_exc()
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            scope.set_tag("pipeline_step", step)
            scope.fingerprint = ["worker-step-exception", step]
            sentry_sdk.capture_exception(e)
    except Exception:
        # Sentry not installed / off / network error — don't let
        # telemetry block the rollback.
        pass
    try:
        conn.rollback()
    except Exception:
        # Don't let a rollback failure mask the original error or kill
        # the worker; the conn will get evicted at .close() if it's
        # really dead.
        pass


def _load_fetch_set(conn) -> list[dict]:
    """
    Build the fetch list for this pass: every monitor at least one active
    user subscribes to (see `get_worker_fetch_set`).
    """
    monitors = get_worker_fetch_set(conn)
    if not monitors:
        print("[worker] empty fetch set — no active user subscribes to a monitor yet")
    return monitors


def _notify_users_of_new_articles(conn, pass_start_iso: str) -> None:
    """
    For each active user, count the articles fetched in this
    pass that their monitors delivered, and broadcast a `new_articles` event
    on `user:{slug}` if > 0.

    Per-user query is cheap (single COUNT on indexed columns, scoped to
    the monitors the user subscribes to).

    `pass_start_iso` is captured at the top of run_one_pass before any
    INSERT — so `fetched_at >= pass_start_iso` cleanly bounds the set of
    articles added during this pass. Both sides are tz-aware UTC
    (items.fetched_at is TIMESTAMPTZ).
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, slug, output_lang
          FROM users
         WHERE active
        """,
    )
    active = cur.fetchall()
    for user_id, slug, output_lang in active:
        monitor_ids = get_user_monitor_ids(conn, user_id)
        if not monitor_ids:
            continue
        # Same predicate as
        # loaders.watch.load_visible_articles — keep the pill count in
        # lockstep with what /watch actually renders, so the count never
        # says "5 new articles" when only 3 are visible.
        cur.execute(
            """
            SELECT COUNT(DISTINCT a.id)
              FROM items a
              JOIN monitor_items mi ON mi.item_id = a.id
             WHERE a.fetched_at >= %s
               AND mi.monitor_id = ANY(%s)
               AND a.archive_seed       = FALSE
               AND a.title_normalized IS NOT NULL
               AND TRIM(a.title_normalized) <> ''
               AND (
                     %s
                  OR a.lang = %s
                  OR (a.title_translations ? %s)
               )
            """,
            (pass_start_iso, monitor_ids,
             output_lang == PIPELINE_LANGUAGE, output_lang, output_lang),
        )
        (count,) = cur.fetchone()
        if count > 0:
            broadcast_new_articles_to_user(slug, count)


def run_one_pass() -> dict:
    """
    Execute one full pass of the pipeline. Each step is isolated with try/except
    so a single failure (e.g. transient OpenAI 429) doesn't skip the rest.

    Returns a stats dict for logging.
    """
    stats = {"step_errors": []}
    # Captured BEFORE any INSERT so the end-of-pass notify step can
    # cleanly bound "articles added during this pass" with `fetched_at
    # >= pass_start_iso`.
    pass_start = datetime.now(timezone.utc)
    pass_start_iso = pass_start.isoformat()
    # Direct (non-pooler) conn required: this pass acquires the
    # pg_try_advisory_lock below, which is session-scoped. A
    # transaction-mode pooler (Supabase pgBouncer port 6543) routes the
    # next transaction to a different real backend and would silently
    # break the lock guarantee. See src/db.py module docstring.
    conn = get_direct_connection()
    # max_retries=5 mirrors every CLI entrypoint.
    # The SDK default is 2; bump it so a transient 429/5xx mid-pass retries
    # with backoff instead of bubbling up and skipping a step's work.
    client = OpenAI(max_retries=5)
    # Session-level advisory lock. close() returns the conn to the pool
    # without ending the session, so the lock would leak — we MUST release
    # it explicitly in finally (a rollback does NOT drop a session lock).
    got_lock = False
    # The pass's Sentry transaction, entered once the lock is held and
    # closed in `finally` with the rest — a no-op when Sentry is off.
    scope = ExitStack()
    try:
        cur = conn.cursor()
        cur.execute("SELECT pg_try_advisory_lock(%s)", (WORKER_PASS_LOCK_KEY,))
        (got_lock,) = cur.fetchone()
        cur.close()
        if not got_lock:
            print("[worker] advisory lock held by another pass — skipping this "
                  "tick (deploy overlap or a slow previous pass)")
            stats["skipped_locked"] = True
            return stats

        monitors = _load_fetch_set(conn)
        print(f"[worker] pass start — {len(monitors)} monitors across active users")

        # One Sentry transaction for the pass, so each step's span lands
        # under one parent timeline.
        scope.enter_context(worker_pass())

        try:
            with step_timer("collect") as t:
                r = collect_and_store(monitors, conn)
                stats["collected"] = r.get("inserted", 0)
                t.set_data("inserted", stats["collected"])
                t.set_data("failed", len(r.get("failed", [])))
                print(f"[worker]   collect: {stats['collected']} new article(s)  "
                      f"(ok={len(r.get('ok', []))}  failed={len(r.get('failed', []))})")
        except Exception as e:
            _handle_step_error(conn, "collect", e, stats)

        try:
            with step_timer("normalize") as t:
                r = normalize_pending(conn, client)
                stats["normalized"] = r.get("normalized", 0)
                t.set_data("normalized", stats["normalized"])
                t.set_data("cost_usd", r.get("cost", 0.0))
                print(f"[worker]   normalize: {stats['normalized']} article(s)  "
                      f"(cost ${r.get('cost', 0.0):.4f})")
        except Exception as e:
            _handle_step_error(conn, "normalize", e, stats)

        # A second call on each normalised article extracts its metadata
        # (categories, keywords, countries, entities, article type) from
        # the clean English text normalisation produced. Pending is
        # `title_normalized IS NOT NULL AND entities IS NULL`, so a failed
        # extraction is retried on the next pass without normalising again.
        try:
            with step_timer("extract") as t:
                r = extract_pending(conn, client)
                stats["extracted"] = r.get("extracted", 0)
                t.set_data("extracted", stats["extracted"])
                t.set_data("cost_usd", r.get("cost", 0.0))
                print(f"[worker]   extract: {stats['extracted']} article(s)  "
                      f"(cost ${r.get('cost', 0.0):.4f})")
        except Exception as e:
            _handle_step_error(conn, "extract", e, stats)

        # Link entity mentions to canonical Wikidata rows: reads
        # `items.entities` (the extractor's typed dump), writes `entities`
        # and `item_entities`, stamps `items.entities_resolved_at`.
        # Embedding and clustering do not read the links; the step runs
        # here so they are ready by the time the article is on screen.
        # Wikidata calls are capped at 8 at once, and the model is asked
        # to disambiguate only when several candidates survive the filters.
        try:
            with step_timer("resolve_entities") as t:
                r = resolve_entities_pending(conn, client)
                stats["entities_resolved_articles"] = r.get("articles", 0)
                stats["entities_resolved_mentions"] = r.get("mentions", 0)
                t.set_data("articles",       r.get("articles", 0))
                t.set_data("mentions",       r.get("mentions", 0))
                t.set_data("wikidata_calls", r.get("wikidata_calls", 0))
                t.set_data("llm_calls",      r.get("llm_calls", 0))
                t.set_data("cost_usd",       r.get("cost", 0.0))
        except Exception as e:
            _handle_step_error(conn, "resolve_entities", e, stats)

        # Re-pull Wikidata for entities not refreshed in
        # the last 30 days. Self-throttling: the WHERE clause excludes
        # fresh rows, so once everything is up-to-date this returns
        # immediately. Hard cap of ~30 entities/pass keeps it cheap.
        try:
            with step_timer("refresh_entities") as t:
                r = refresh_stale_entities(conn)
                t.set_data("candidates",     r.get("candidates", 0))
                t.set_data("refreshed",      r.get("refreshed", 0))
                t.set_data("wikidata_calls", r.get("wikidata_calls", 0))
        except Exception as e:
            _handle_step_error(conn, "refresh_entities", e, stats)

        try:
            with step_timer("embed") as t:
                r = embed_pending(conn, client)
                stats["embedded"] = r.get("embedded", 0)
                t.set_data("embedded", stats["embedded"])
                t.set_data("cost_usd", r.get("cost", 0.0))
                print(f"[worker]   embed: {stats['embedded']} article(s)  "
                      f"(cost ${r.get('cost', 0.0):.4f})")
        except Exception as e:
            _handle_step_error(conn, "embed", e, stats)

        try:
            with step_timer("cluster") as t:
                r = cluster_pending(conn)
                stats["clustered"] = r.get("attached", 0) + r.get("new_stories", 0)
                t.set_data("attached", r.get("attached", 0))
                t.set_data("new_stories", r.get("new_stories", 0))
                t.set_data("closed", r.get("closed", 0))
                print(f"[worker]   cluster: attached={r.get('attached', 0)}  "
                      f"new={r.get('new_stories', 0)}  closed={r.get('closed', 0)}")
        except Exception as e:
            _handle_step_error(conn, "cluster", e, stats)

        # The story's label, synthesis, origin and timeline, in one call
        # per story with unread articles (src/story_state.py).
        try:
            with step_timer("story_state") as t:
                r = refresh_story_states(conn, client)
                stats["story_state"] = r
                t.set_data("stories", r["stories"])
                t.set_data("notes", r["notes"])
                t.set_data("cost_usd", r["cost"])
                print(f"[worker]   story_state: {r['stories']} stor(ies), "
                      f"{r['notes']} note(s), {r['failed']} failed  "
                      f"(cost ${r['cost']:.4f})")
        except Exception as e:
            _handle_step_error(conn, "story_state", e, stats)

        # Each reader's agents judge the stories that received articles
        # they have not seen, now that the stories' text is current
        # (src/judge.py).
        try:
            with step_timer("judge") as t:
                r = judge_pending(conn, client, pass_start)
                stats["judge"] = r
                t.set_data("judged", r["judged"])
                t.set_data("kept", r["kept"])
                t.set_data("cost_usd", r["cost"])
                t.set_data("skipped", r["skipped"])
                print(f"[worker]   judge: {r['judged']} stor(ies), {r['kept']} kept, "
                      f"{r['skipped']} skipped, {r['failed']} failed  (cost ${r['cost']:.4f})")
        except Exception as e:
            _handle_step_error(conn, "judge", e, stats)

        # Everything the reader is shown, in their language: the articles'
        # titles and summaries, then the stories' text written above.
        try:
            with step_timer("article_translate") as t:
                r = refresh_article_translations(conn, client)
                stats["article_translate"] = r
                t.set_data("translated", r["translated"])
                t.set_data("cost_usd", r["cost"])
                print(f"[worker]   article_translate: {r['translated']} article(s)  "
                      f"(cost ${r['cost']:.4f})")
        except Exception as e:
            _handle_step_error(conn, "article_translate", e, stats)

        try:
            with step_timer("story_translate") as t:
                r = refresh_story_translations(conn, client)
                stats["story_translate"] = r
                t.set_data("translated", r["translated"])
                t.set_data("cost_usd", r["cost"])
                print(f"[worker]   story_translate: {r['translated']} text(s) "
                      f"over {r['stories']} stor(ies)  (cost ${r['cost']:.4f})")
        except Exception as e:
            _handle_step_error(conn, "story_translate", e, stats)

        # Broadcast a `new_articles` Realtime event per affected user, so
        # the Watch shows its "new articles" pill without polling. Skipped if no article was inserted in
        # this pass. Broadcast failures don't fail the pass.
        try:
            with step_timer("notify_users"):
                if stats.get("collected", 0) > 0:
                    _notify_users_of_new_articles(conn, pass_start_iso)
        except Exception as e:
            _handle_step_error(conn, "notify_users", e, stats)

        # Heartbeat, at the end of every pass whatever happened, so the
        # app's "updated at HH:MM" indicator shows the system just checked
        # even when no new article arrived. The
        # dot Realtime indicator covers fatal connectivity drops; this
        # heartbeat covers the "alive but quiet" case.
        try:
            with step_timer("heartbeat"):
                broadcast_worker_heartbeat(datetime.now(timezone.utc).isoformat())
        except Exception as e:
            _handle_step_error(conn, "heartbeat", e, stats)
    finally:
        scope.close()
        # Release the advisory lock before returning the conn to the pool,
        # else it stays held for the life of the pooled session and every
        # future pass would skip on a freshly-borrowed connection.
        if got_lock:
            try:
                cur = conn.cursor()
                cur.execute("SELECT pg_advisory_unlock(%s)", (WORKER_PASS_LOCK_KEY,))
                cur.close()
                conn.commit()
            except Exception:
                pass
        try:
            conn.close()
        except Exception:
            pass

    # Report degraded steps to Sentry (one grouped issue per step). The
    # worker never crashes on a step error, so without this they'd only
    # ever show up in the logs nobody is watching at 3am.
    for step, detail in stats.get("step_errors", []):
        capture_step_failure(step, detail)

    return stats


def run_forever() -> None:
    """
    Main loop. Calls run_one_pass repeatedly. Catches everything so the
    process never dies. Adapts sleep length depending on what happened.
    """
    print("[worker] continuous ingest loop starting")
    init_sentry("worker")
    while True:
        try:
            stats = run_one_pass()
            had_errors = bool(stats.get("step_errors"))
            sleep_s = SLEEP_AFTER_ERROR if had_errors else SLEEP_AFTER_SUCCESS
            print(f"[worker] pass done — sleeping {sleep_s}s "
                  f"(step_errors={len(stats.get('step_errors', []))})")
        except Exception as e:
            # Anything escaping run_one_pass = catastrophic (e.g. can't even
            # open a DB connection). Wait longer and retry, never crash.
            print(f"[worker] [FATAL] pass crashed: {type(e).__name__}: {e}")
            traceback.print_exc()
            capture_fatal(e)
            sleep_s = SLEEP_AFTER_FATAL

        time.sleep(sleep_s)


def main(argv: list[str] | None = None) -> int:
    """Command line entry point. Returns a process exit code.

    Two deployment shapes share this module, and the difference between
    them is one flag:

      python -m src.runner           a long-lived worker, loops forever
      python -m src.runner --once    a single pass, then exits

    `--once` is what a scheduled job runs. The distinction matters because
    a scheduler judges the run by its exit code, whereas the loop judges it
    by how long to sleep next.
    """
    parser = argparse.ArgumentParser(
        prog="python -m src.runner",
        description="Run the ingest pipeline, once or continuously.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="run a single pass and exit, instead of looping (for a cron job)",
    )
    args = parser.parse_args(argv)

    if not args.once:
        run_forever()  # never returns
        return 0

    init_sentry("worker")
    try:
        stats = run_one_pass()
    except Exception as e:
        # Only a crash fails the run. The pipeline could not do its job at
        # all — no database, no credentials — and the scheduler should show
        # red.
        print(f"[worker] [FATAL] pass crashed: {type(e).__name__}: {e}")
        traceback.print_exc()
        capture_fatal(e)
        return 1

    step_errors = stats.get("step_errors", [])
    if step_errors:
        # A failed step exits 0 on purpose. One step throwing a transient
        # 429 while the other eleven did their work is not a failed run, and
        # marking it red trains you to ignore the colour. These are already
        # reported individually to Sentry by run_one_pass, which is the
        # channel that can actually tell you a step has been broken for
        # three days.
        names = ", ".join(step for step, _ in step_errors)
        print(f"[worker] pass done with {len(step_errors)} step error(s): {names}")
    else:
        print("[worker] pass done, no step errors")
    return 0


# Entry point for both Render services: the background worker runs this
# module bare, the scheduled job runs it with --once. Kept here rather than
# in scripts/ so the same module that defines the loop can be invoked
# directly, with no wrapper to keep in step.
if __name__ == "__main__":
    sys.exit(main())
