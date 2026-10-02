"""
Sentry initialisation + per-step worker telemetry — shared by the
FastAPI API and the ingest worker.

No-op unless SENTRY_DSN is set, so local dev and tests never phone home
and don't need any config. Turn it on by setting these env vars on Render:

  SENTRY_DSN                  (required to enable)
  SENTRY_ENVIRONMENT          (optional, default "production")
  SENTRY_TRACES_SAMPLE_RATE   (optional, default "0.1" — see below.
                               Set "0.0" to disable performance tracing
                               and keep only error capture. Setting it
                               above 0 enables per-step transactions /
                               spans so step latency shows up in
                               Sentry's Performance tab.)

The API auto-captures unhandled 500s once initialised (sentry-sdk detects
FastAPI/Starlette and installs its integration). The worker swallows
per-step exceptions by design, so it reports them explicitly via
`capture_step_failure` / `capture_fatal` below.

Per-step latency is captured via `step_timer(name)` (a context manager
that logs the duration and emits a Sentry span). Wrap the whole pass
with `worker_pass()` so each step's span lands under one parent
transaction — Sentry's Performance UI then shows the pass as a single
timeline with steps as bars.
"""
import contextlib
import os
import time

_INITIALISED = False


def init_sentry(component: str) -> None:
    """Initialise Sentry for `component` ("api" | "worker"). Idempotent."""
    global _INITIALISED
    if _INITIALISED:
        return

    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return

    try:
        import sentry_sdk
    except ImportError:
        print(f"[{component}] SENTRY_DSN set but sentry-sdk missing — skipping")
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT", "production"),
        # Default 0.1 (10%) so per-pass transactions land in Sentry's
        # Performance tab without flooding quota. The worker only fires
        # ~6 passes/hour so even 1.0 would be ~144 transactions/day —
        # negligible. Set 0.0 to disable performance, 1.0 to capture
        # every pass.
        traces_sample_rate=float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1")),
        send_default_pii=False,
    )
    sentry_sdk.set_tag("component", component)
    _INITIALISED = True
    env = os.getenv("SENTRY_ENVIRONMENT", "production")
    print(f"[{component}] Sentry initialised (env={env})")


def capture_step_failure(step: str, detail: str) -> None:
    """Report a single degraded pipeline step (the worker keeps the error
    as a string and carries on, so we send a message, not an exception).
    `fingerprint=[step]` groups all failures of the same step into one
    Sentry issue. Safe no-op if Sentry is off."""
    if not _INITIALISED:
        return
    import sentry_sdk

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("pipeline_step", step)
        scope.fingerprint = ["worker-step-failure", step]
        sentry_sdk.capture_message(f"[worker] step '{step}' failed: {detail}", level="error")


def capture_fatal(exc: BaseException) -> None:
    """Report a catastrophic pass crash (whole pass aborted)."""
    if not _INITIALISED:
        return
    import sentry_sdk

    sentry_sdk.capture_exception(exc)


# ── Feed lifecycle ───────────────────────────────────────────────────────
# Each helper produces one Sentry issue PER FEED (via fingerprint
# including the feed slug). That's what lets us triage feed-by-feed
# instead of seeing one mega-issue with thousands of events. Safe no-op
# when Sentry is off.

def capture_feed_degradation(slug: str, consecutive_failures: int, reason: str) -> None:
    """Feed has just transitioned active → degraded.

    `reason` is a short string (the HTTP status or error class).
    Fingerprint groups all degradation events for the same feed in one
    issue, so a feed that keeps flipping degraded/active over weeks still
    surfaces as a single trail rather than spamming new issues.
    """
    if not _INITIALISED:
        return
    import sentry_sdk

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("feed_event", "degradation")
        scope.set_tag("feed_slug", slug)
        scope.set_extra("consecutive_failures", consecutive_failures)
        scope.set_extra("reason", reason)
        scope.fingerprint = ["feed-degradation", slug]
        sentry_sdk.capture_message(
            f"[feed] {slug} degraded after {consecutive_failures} consecutive failures ({reason})",
            level="warning",
        )


def capture_feed_death(slug: str, consecutive_failures: int, reason: str) -> None:
    """Feed has just transitioned degraded → dead.

    Worker will skip the feed entirely until manual revival. Sentry
    issue is `error` level so it shows up high in triage.
    """
    if not _INITIALISED:
        return
    import sentry_sdk

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("feed_event", "death")
        scope.set_tag("feed_slug", slug)
        scope.set_extra("consecutive_failures", consecutive_failures)
        scope.set_extra("reason", reason)
        scope.fingerprint = ["feed-death", slug]
        sentry_sdk.capture_message(
            f"[feed] {slug} marked dead after {consecutive_failures} consecutive failures ({reason}) "
            "— worker will skip until manually revived",
            level="error",
        )


def capture_feed_redirect_conflict(
    slug: str, old_url: str, new_url: str, existing_feed_id: int,
) -> None:
    """Feed redirects stably to a URL already held by ANOTHER feed row.

    Auto-migration is blocked (would violate `feeds_url_key` UNIQUE).
    We reset the redirect tracking so the worker stops re-triggering
    the migration attempt every pass; the feed keeps working at its old
    URL (following the 301 on each fetch, small perf cost only).

    The operator should reconcile the catalog: either merge the two rows,
    delete the duplicate, or accept the redirect and swap slugs.
    """
    if not _INITIALISED:
        return
    import sentry_sdk

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("feed_event", "redirect_conflict")
        scope.set_tag("feed_slug", slug)
        scope.set_extra("old_url",          old_url)
        scope.set_extra("new_url",          new_url)
        scope.set_extra("existing_feed_id", existing_feed_id)
        scope.fingerprint = ["feed-redirect-conflict", slug]
        sentry_sdk.capture_message(
            f"[feed] redirect conflict for {slug}: cannot migrate "
            f"{old_url} → {new_url} (already held by feed id={existing_feed_id})",
            level="warning",
        )


def capture_feed_url_migrated(slug: str, old_url: str, new_url: str) -> None:
    """Feed has redirected stably for N passes → URL auto-migrated.

    The operator should update `config/catalog.json` to match the new URL,
    otherwise the next catalog_sync will revert it (catalog is source
    of truth for URLs). The Sentry alert is the signal to take action.
    """
    if not _INITIALISED:
        return
    import sentry_sdk

    with sentry_sdk.push_scope() as scope:
        scope.set_tag("feed_event", "url_migrated")
        scope.set_tag("feed_slug", slug)
        scope.set_extra("old_url", old_url)
        scope.set_extra("new_url", new_url)
        scope.fingerprint = ["feed-url-migration", slug]
        sentry_sdk.capture_message(
            f"[feed] {slug} URL auto-migrated: {old_url} → {new_url}. "
            "Update config/catalog.json to match (next catalog_sync will revert otherwise).",
            level="warning",
        )


# ── Per-step timing ──────────────────────────────────────────────────────
# The worker is a long sequential pipeline; without timing we can't tell
# which step is the bottleneck. These context managers report duration
# to BOTH a structured log line (visible in Render logs) AND a Sentry
# span (visible in Sentry's Performance tab).
#
# Pattern in runner.py:
#
#   with worker_pass() as pass_ctx:
#       with step_timer("normalize", pass_ctx) as t:
#           ...   # do the step
#           t.set_tag("articles", n)   # optional, lands as tag on span


class _NoopTimer:
    """Returned when Sentry is off. Same surface as `_StepTimer`, all no-ops
    so callers don't need a None-check."""
    def __enter__(self) -> "_NoopTimer":
        self._t0 = time.perf_counter()
        return self
    def __exit__(self, *_exc) -> None:
        pass
    def set_tag(self, *_args, **_kwargs) -> None:
        pass
    def set_data(self, *_args, **_kwargs) -> None:
        pass
    @property
    def duration_ms(self) -> float:
        return (time.perf_counter() - self._t0) * 1000.0


class _StepTimer:
    """Sentry-backed step timer. Wraps a `start_span` + emits a log line
    on exit with the duration. Exposes `set_tag` / `set_data` so callers
    can attach step-specific metadata (e.g. `t.set_tag("articles", 42)`)."""
    def __init__(self, name: str) -> None:
        self._name = name
        self._span = None
        self._t0 = 0.0

    def __enter__(self) -> "_StepTimer":
        self._t0 = time.perf_counter()
        import sentry_sdk
        # `start_span` attaches to the active transaction if one exists
        # (= we're inside `worker_pass`). Otherwise it becomes a
        # standalone span which Sentry will drop without a transaction
        # parent — that's fine, we still log locally.
        self._span = sentry_sdk.start_span(op="worker.step", description=self._name)
        self._span.__enter__()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        dur_ms = (time.perf_counter() - self._t0) * 1000.0
        if self._span is not None:
            try:
                self._span.set_data("duration_ms", round(dur_ms, 1))
                if exc_type is not None:
                    self._span.set_status("internal_error")
                    self._span.set_data("error", repr(exc_val))
            finally:
                self._span.__exit__(exc_type, exc_val, exc_tb)
        # Structured log — same format whether Sentry is on or off, so
        # Render logs always have it. Plain string + structured tags so
        # log aggregators can parse.
        status = "error" if exc_type is not None else "ok"
        print(f"[worker.timing] step={self._name} duration_ms={dur_ms:.0f} status={status}")

    def set_tag(self, key: str, value) -> None:
        if self._span is not None:
            self._span.set_tag(key, value)

    def set_data(self, key: str, value) -> None:
        if self._span is not None:
            self._span.set_data(key, value)

    @property
    def duration_ms(self) -> float:
        return (time.perf_counter() - self._t0) * 1000.0


def step_timer(name: str):
    """Context manager that times a worker step. Yields a handle with
    `.set_tag(k, v)` / `.set_data(k, v)` for step-specific metadata.
    No-op (still times + logs) when Sentry isn't initialised."""
    if not _INITIALISED:
        return _NoopTimer()
    return _StepTimer(name)


@contextlib.contextmanager
def worker_pass():
    """Wraps a full worker pass in a Sentry transaction so per-step spans
    land under one parent timeline. Yields the transaction handle (or
    None when Sentry is off) — callers usually ignore it and just use
    it for the `with` scope.

    Usage:
        with worker_pass():
            with step_timer("normalize") as t:
                ...
            with step_timer("embed") as t:
                ...
    """
    if not _INITIALISED:
        yield None
        return
    import sentry_sdk
    with sentry_sdk.start_transaction(op="worker.pass", name="worker.pass") as tx:
        yield tx
