"""
Data retention constants — single source of truth.

The DB cleanup (pg_cron `cleanup-old-data`) removes articles older than
14 days that aren't attached to an active/saved/folder-held story. All
UX surfaces that filter by time (SPA period selector, view counters,
query editor preview) must cap their max window to this same value —
otherwise a user could pick "30 days" and see a mostly-empty result set
because the older articles are physically gone.

Change this and the whole stack shifts in lockstep: the SPA dropdown
disallows values above it, the counters clip to it, the query editor
preview label reads "N matches · max window Xd". The cleanup cron
schedule itself is separate (defined in `migrations/*` / Supabase
pg_cron) — you still need to change BOTH if you want the actual DB
retention to move.
"""
from __future__ import annotations

# Days of data retention. Must match the WHERE clause of the pg_cron
# cleanup job (see CLAUDE.md § Data retention).
RETENTION_MAX_DAYS  = 14
RETENTION_MAX_HOURS = RETENTION_MAX_DAYS * 24  # 336


# Presets exposed to the SPA period selector. Ordered from tightest
# (live/breaking) to widest (retention cap). Values are in hours to
# match the `period_hours` API contract.
SPA_PERIOD_PRESETS_H: list[int] = [
    1,             # breaking / crisis mode
    6,             # half-day check
    24,            # daily brief cadence (default)
    24 * 3,        # weekend catch-up
    24 * 7,        # weekly overview
    RETENTION_MAX_HOURS,  # retention cap
]

# Default period surfaced to a fresh user. Matches the "daily brief"
# cadence of a working veilleur pro.
SPA_PERIOD_DEFAULT_H = 24
