"""
Online greedy incremental clustering, with pgvector.

For each pending article (embedded, not yet attached to any story, recent enough)
in chronological order, match against active stories using cosine similarity
with an age-based threshold. Attach to the best match or create a new story.
Maintain centroids as running means in DB. Close stale stories at the end.

pgvector:
  - Centroids and article embeddings live in pgvector(1536) columns
    (stories.centroid, items.title_embedding, items.summary_embedding).
  - The kNN match against active stories is done server-side with the
    pgvector `<=>` (cosine distance) operator + the age threshold encoded
    as a SQL CASE, instead of pulling every centroid into Python.
"""
import json
import time
from datetime import datetime

import numpy as np

from src.notifications import fan_out_followers

# Title/summary weights for the combined embedding (validated empirically).
TITLE_W   = 0.4
SUMMARY_W = 0.6

# Age-based threshold curve: 0.63 fresh, 0.85 mature. Both values favour
# tighter, shorter-lived stories: most stories should span <24h. Stricter
# mature threshold means older stories barely attract new articles, which
# combined with the 36h temporal close makes stories self-segment into
# successive "angles" of an event rather than accreting into long sagas.
# 0.63 fresh threshold filters out the loose-association matches that 0.60
# would have let through.
THRESHOLD_FRESH    = 0.63   # age <= 12h
THRESHOLD_MATURE   = 0.85   # age >= 36h
RAMP_START_HOURS   = 12
RAMP_END_HOURS     = 36

# Temporal close: stories whose latest_pub is older than this become 'closed'.
CLOSE_GAP_HOURS    = 36

# Progress log frequency (every N articles processed).
LOG_EVERY          = 100


# SQL CASE expression for the age-based similarity threshold curve, evaluated
# server-side as part of the kNN match query:
#   - 0.63 while story age ≤ 12h         (fresh, accepts loose matches)
#   - linear ramp 0.63 → 0.85 from 12h to 36h
#   - 0.85 once age ≥ 36h                 (mature, near-duplicate only)
# Higher threshold for older stories prevents sagas from accreting forever
# and makes most stories naturally fit within a 24h window.
# `age_h` is the candidate column name produced by the surrounding query.
_SQL_AGE_THRESHOLD = f"""
    CASE
        WHEN age_h <= {RAMP_START_HOURS} THEN {THRESHOLD_FRESH}
        WHEN age_h >= {RAMP_END_HOURS}   THEN {THRESHOLD_MATURE}
        ELSE {THRESHOLD_FRESH}
             + ({THRESHOLD_MATURE} - {THRESHOLD_FRESH})
               * (age_h - {RAMP_START_HOURS})
               / ({RAMP_END_HOURS} - {RAMP_START_HOURS})
    END
"""


# ---------------------------------------------------------------------------
# Pure helpers — no DB
# ---------------------------------------------------------------------------
def _combine_embeddings(title_vec: np.ndarray, summary_vec: np.ndarray | None) -> np.ndarray:
    """Title-only when no summary is available, otherwise weighted avg + re-norm."""
    if summary_vec is None:
        return title_vec
    combined = TITLE_W * title_vec + SUMMARY_W * summary_vec
    return combined / np.linalg.norm(combined)


def _running_mean_update(old_centroid: np.ndarray, n: int, new_vec: np.ndarray) -> np.ndarray:
    """O(1) centroid update over (n+1) articles, then re-normalize."""
    new = (n * old_centroid + new_vec) / (n + 1)
    return new / np.linalg.norm(new)


def _is_singleton_candidate(title_normalized: str | None, summary_normalized: str | None) -> bool:
    """
    Force singleton for likely-truncated entries: feedparser sometimes returns
    titles like 'VIDEO' or single words from multimedia stubs. Without this
    guard, several unrelated stubs could collide on a generic embedding.
    """
    title   = (title_normalized or "").strip()
    summary = (summary_normalized or "").strip()
    return len(title.split()) <= 2 and not summary


def _vec_to_pg(vec: np.ndarray) -> str:
    """Serialize a numpy float vector to the bracketed text form pgvector accepts."""
    return json.dumps(vec.tolist())


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def _load_pending_articles(conn, max_age_hours: int) -> list[dict]:
    """
    Pending = embedded, not archive, recent enough, not yet linked to any
    story. Sorted by chronological effective_pub so the replay reflects the
    temporal order new articles arrived.
    """
    cur = conn.cursor()
    # COALESCE(published_at, fetched_at) — published_at when feed gave one,
    # else the moment we first saw the article. Both are TIMESTAMPTZ
    # so they compare directly against story.created_at.
    cur.execute(f"""
        SELECT
            a.id,
            a.title_embedding,
            a.summary_embedding,
            a.title_normalized,
            a.summary_normalized,
            COALESCE(a.published_at, a.fetched_at) AS effective_pub
        FROM items a
        WHERE a.title_embedding IS NOT NULL
          AND a.archive_seed = FALSE
          AND COALESCE(a.published_at, a.fetched_at)
              >= NOW() - INTERVAL '{int(max_age_hours)} hours'
          AND NOT EXISTS (
              SELECT 1 FROM story_items sa WHERE sa.item_id = a.id
          )
        ORDER BY effective_pub ASC
    """)
    return [
        {
            "id":                 r[0],
            "title_emb":          np.array(json.loads(r[1]), dtype=np.float32),
            "summary_emb":        np.array(json.loads(r[2]), dtype=np.float32) if r[2] else None,
            "title_normalized":   r[3],
            "summary_normalized": r[4],
            "effective_pub":      r[5],
        }
        for r in cur.fetchall()
    ]


def _find_best_match(conn, vec: np.ndarray, effective_pub: datetime) -> dict | None:
    """
    Server-side kNN: find the active story whose centroid is closest to `vec`
    AND whose age-adjusted threshold is satisfied. Returns the best candidate
    as {"id", "n_items", "centroid", "latest_pub"} or None when no story
    above its age threshold exists.

    Why server-side: avoids pulling every active story's centroid (O(N) MB
    per pass on large corpora). Postgres + pgvector compute cosine in C.
    """
    cur = conn.cursor()
    cur.execute(f"""
        WITH candidates AS (
            SELECT
                id,
                n_items,
                centroid,
                latest_pub,
                1 - (centroid <=> %s::vector(1536)) AS sim,
                EXTRACT(EPOCH FROM (%s::timestamptz - created_at)) / 3600 AS age_h
            FROM stories
            WHERE status = 'active'
              AND centroid IS NOT NULL
        )
        SELECT id, n_items, centroid, latest_pub, sim
        FROM candidates
        WHERE sim >= {_SQL_AGE_THRESHOLD}
        ORDER BY sim DESC
        LIMIT 1
    """, (_vec_to_pg(vec), effective_pub))
    row = cur.fetchone()
    if not row:
        return None
    return {
        "id":         row[0],
        "n_items": row[1],
        "centroid":   np.array(json.loads(row[2]), dtype=np.float32),
        "latest_pub": row[3],
    }


def _create_story_with_article(conn, article: dict, vec: np.ndarray) -> None:
    """Insert a new story row (centroid from the article's embedding) and link it."""
    cur = conn.cursor()
    cur.execute(
        """INSERT INTO stories (centroid, n_items, latest_pub)
           VALUES (%s::vector(1536), 1, %s)
           RETURNING id""",
        (_vec_to_pg(vec), article["effective_pub"]),
    )
    story_id = cur.fetchone()[0]
    cur.execute(
        "INSERT INTO story_items (story_id, item_id) VALUES (%s, %s)",
        (story_id, article["id"]),
    )


def _attach_article_to_story(conn, article: dict, match: dict, vec: np.ndarray) -> None:
    """Update centroid + n_items + latest_pub on the matched story, link the article."""
    new_centroid = _running_mean_update(match["centroid"], match["n_items"], vec)
    new_n        = match["n_items"] + 1
    new_latest   = max(match["latest_pub"], article["effective_pub"])
    cur = conn.cursor()
    cur.execute(
        """UPDATE stories
           SET centroid=%s::vector(1536),
               n_items=%s,
               latest_pub=%s,
               last_attached_at=NOW()
           WHERE id=%s""",
        (_vec_to_pg(new_centroid), new_n, new_latest, match["id"]),
    )
    cur.execute(
        "INSERT INTO story_items (story_id, item_id) VALUES (%s, %s)",
        (match["id"], article["id"]),
    )

    # Story-follow notification fan-out. Only
    # fires on attachments to EXISTING stories, which is exactly the
    # surface story_follows.story_id can point to — fresh story
    # creations in `_create_story_with_article` never have followers
    # yet by construction. Best-effort: failure logs and continues so
    # a Realtime hiccup or follower table glitch doesn't roll back the
    # cluster attachment that just happened.
    try:
        cur.execute("SELECT label FROM stories WHERE id = %s", (match["id"],))
        row = cur.fetchone()
        story_title = row[0] if row and row[0] else None
        fan_out_followers(
            conn,
            match["id"],
            "story_update",
            {
                "story_id":      match["id"],
                "story_title":   story_title,
                "kind":          "new_article",
                "article_id":    article["id"],
                "article_title": (article.get("title_normalized") or article.get("title") or "")[:200],
                "source":        article.get("source_name") or article.get("feed_name"),
            },
        )
    except Exception as e:
        print(f"  [clusterer] notif fan-out failed story={match['id']}: "
              f"{type(e).__name__}: {e}", flush=True)


def _temporal_close(conn) -> int:
    cur = conn.cursor()
    cur.execute(f"""
        UPDATE stories
        SET status = 'closed'
        WHERE status = 'active'
          AND latest_pub < NOW() - INTERVAL '{int(CLOSE_GAP_HOURS)} hours'
    """)
    n = cur.rowcount
    conn.commit()
    return n


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def cluster_pending(conn, max_age_hours: int = 48) -> dict:
    """
    Online greedy incremental clustering. Returns stats dict.

    Args:
        conn:           open DB connection
        max_age_hours:  only cluster articles whose effective_pub is within this
                        window. Default 48h covers ~6 cron cycles of catch-up
                        margin without sweeping the historical archive.
                        Backfill script passes a larger value (e.g. 72h).
    """
    articles = _load_pending_articles(conn, max_age_hours)

    if not articles:
        # Even with nothing pending, run the temporal close — old active
        # stories should still tick over to 'closed' once they age out.
        n_closed = _temporal_close(conn)
        return {"attached": 0, "new_stories": 0, "skipped_singleton": 0, "closed": n_closed}

    n_total     = len(articles)
    pad         = len(str(n_total))
    n_attached  = 0
    n_new       = 0
    n_singleton = 0
    t_start     = time.time()

    print(f"  Clustering {n_total} pending article(s) via pgvector kNN...")

    for i, article in enumerate(articles, 1):
        vec = _combine_embeddings(article["title_emb"], article["summary_emb"])

        # Singleton guard — feedparser truncation artefacts / VIDEO stubs.
        if _is_singleton_candidate(article["title_normalized"], article["summary_normalized"]):
            _create_story_with_article(conn, article, vec)
            n_singleton += 1
            n_new       += 1
        else:
            match = _find_best_match(conn, vec, article["effective_pub"])
            if match is not None:
                _attach_article_to_story(conn, article, match, vec)
                n_attached += 1
            else:
                _create_story_with_article(conn, article, vec)
                n_new += 1

        conn.commit()  # per-article durability

        # Progress log: once every LOG_EVERY articles, plus the last iteration.
        if i % LOG_EVERY == 0 or i == n_total:
            elapsed = time.time() - t_start
            rate    = i / max(elapsed, 0.001)
            eta_s   = (n_total - i) / max(rate, 0.001)
            print(f"  [{i:>{pad}}/{n_total}] "
                  f"attached={n_attached:<4} "
                  f"new={n_new:<4} "
                  f"singleton={n_singleton:<3} "
                  f"({rate:.1f} art/s, ETA {eta_s:.0f}s)")

    n_closed = _temporal_close(conn)

    return {
        "attached":          n_attached,
        "new_stories":       n_new,
        "skipped_singleton": n_singleton,
        "closed":            n_closed,
    }
