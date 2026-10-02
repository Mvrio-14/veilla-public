"""
Monitors and the people who follow them.

A reader never subscribes to a monitor directly: they pick entries from
the catalog, and each entry is fetched by one public monitor that every
subscriber shares. The monitor is created the first time anyone follows
the entry, so an entry nobody follows costs nothing.

`subscriptions(user_id, monitor_id)` then answers two questions at once:
what a reader sees, and — over every active reader — what the worker
fetches. A monitor nobody follows is not fetched.
"""
from __future__ import annotations

import json

from src.templates import TEMPLATES, get_template


# ── Catalog entries and their public monitor ───────────────────────────────
def get_or_create_public_monitor(cur, catalog_id: int) -> int:
    """The public monitor that fetches a catalog entry, created if needed.

    Safe under concurrency: two sign-ups racing on the same entry meet on
    the unique `catalog_id`, and both get the same monitor.
    """
    cur.execute(
        "SELECT id FROM monitors WHERE catalog_id = %s",
        (catalog_id,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        """SELECT name, template, config, identity_key, source_id
             FROM catalog
            WHERE id = %s""",
        (catalog_id,),
    )
    entry = cur.fetchone()
    if entry is None:
        raise LookupError(f"catalog entry {catalog_id} does not exist")
    name, template, config, identity_key, source_id = entry
    tpl = get_template(template)

    # The no-op update is what makes RETURNING give the winner's id.
    cur.execute(
        """
        INSERT INTO monitors (
            name, template, fetch_method, kind, config, identity_key,
            visibility, catalog_id, source_id
        )
        VALUES (%s, %s, %s, %s, %s, %s, 'public', %s, %s)
        ON CONFLICT (catalog_id)
        DO UPDATE SET catalog_id = EXCLUDED.catalog_id
        RETURNING id
        """,
        (
            name, template, tpl.fetch_method, tpl.kind, json.dumps(config),
            identity_key, catalog_id, source_id,
        ),
    )
    return cur.fetchone()[0]


def subscribe(cur, user_id: str, monitor_ids: list[int]) -> None:
    for monitor_id in monitor_ids:
        cur.execute(
            "INSERT INTO subscriptions (user_id, monitor_id) VALUES (%s, %s) "
            "ON CONFLICT DO NOTHING",
            (user_id, monitor_id),
        )


def subscribe_to_starter_entries(cur, user_id: str) -> int:
    """Subscribe a new account to the catalog entries flagged `starter`.

    A reader's subscriptions are both what their watch screen shows and
    what the worker fetches, so an account with none is blank until its
    owner opens Settings — and a first visit is exactly when nobody does.
    The starter set is the answer; a pro account can unfollow any of it.

    It is a snapshot, not a link: an entry flagged `starter` later reaches
    only the accounts created after it. Returns how many entries.
    """
    cur.execute("SELECT id FROM catalog WHERE starter ORDER BY id")
    catalog_ids = [row[0] for row in cur.fetchall()]
    subscribe(cur, user_id, [get_or_create_public_monitor(cur, cid) for cid in catalog_ids])
    return len(catalog_ids)


# ── What a reader sees ─────────────────────────────────────────────────────
def get_user_monitor_ids(conn, user_id: str) -> list[int]:
    """The monitors a reader follows: the scope of everything they read."""
    cur = conn.cursor()
    cur.execute(
        "SELECT monitor_id FROM subscriptions WHERE user_id = %s ORDER BY monitor_id",
        (user_id,),
    )
    return [row[0] for row in cur.fetchall()]


def get_user_monitors(conn, user_id: str) -> list[dict]:
    """The monitors a reader follows, as the feed list the UI filters on.

    `country` is the content language of the catalog entry, when the
    monitor has one. Sorted by name for a stable display order.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT m.id, m.name, m.config ->> 'url', c.country
          FROM subscriptions s
          JOIN monitors m           ON m.id = s.monitor_id
          LEFT JOIN catalog c ON c.id = m.catalog_id
         WHERE s.user_id = %s
         ORDER BY m.name
        """,
        (user_id,),
    )
    return [
        {"id": row[0], "name": row[1], "url": row[2], "country": row[3]}
        for row in cur.fetchall()
    ]


# ── What the worker fetches ────────────────────────────────────────────────
def get_worker_fetch_set(conn) -> list[dict]:
    """Monitors the worker fetches on this pass.

    A monitor is fetched when at least one active reader follows it, so
    deactivating an account stops the fetching it alone was causing, and
    when its template is one this code knows.

    Health decides the rest: a dead monitor is skipped, and a degraded
    one is tried one pass in ten, picked by its id so that the choice
    needs no state of its own.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT m.id, m.name, m.template, m.config, m.source_id,
               m.catalog_id, m.status, m.consecutive_failures, m.cursor
          FROM monitors m
         WHERE m.template = ANY(%s)
           AND EXISTS (
                 SELECT 1
                   FROM subscriptions s
                   JOIN users u ON u.id = s.user_id
                  WHERE s.monitor_id = m.id
                    AND u.active
               )
           AND (
                 m.status = 'active'
              OR (
                   m.status = 'degraded'
                   AND MOD(FLOOR(EXTRACT(EPOCH FROM now()) / 300)::bigint, 10)
                     = MOD(m.id, 10)
                 )
               )
         ORDER BY m.id
        """,
        (list(TEMPLATES),),
    )
    return [
        {
            "id":                   row[0],
            "name":                 row[1],
            "template":             row[2],
            "config":               row[3],
            "source_id":            row[4],
            "catalog_id":      row[5],
            "status":               row[6],
            "consecutive_failures": row[7],
            "cursor":               row[8],
        }
        for row in cur.fetchall()
    ]
