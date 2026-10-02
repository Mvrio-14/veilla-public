"""
Article embedding: compute OpenAI text-embedding-3-small vectors for normalized
articles and store them as native pgvector(1536) values in
items.title_embedding and items.summary_embedding.

Title is always embedded once title_normalized is present.
Summary is embedded only when summary_normalized is non-empty; otherwise NULL.
Vectors are L2-normalized so downstream cosine similarity is a dot product.
"""
import json
import time
from datetime import datetime, timedelta, timezone

import numpy as np
from openai import OpenAI

from src.llm_costs import estimate_cost
from src.llm_costs import log_call as log_llm_call
from src.llm_models import EMBEDDING_MODEL

MODEL      = EMBEDDING_MODEL
DIM        = 1536
BATCH_SIZE = 100


def _embed_texts(texts: list[str], client: OpenAI) -> tuple[np.ndarray, int, int]:
    """Send one batch to the OpenAI embeddings API.

    Returns (L2-normalized matrix, prompt_tokens, duration_ms).
    """
    t0 = time.perf_counter()
    resp = client.embeddings.create(model=MODEL, input=texts)
    duration_ms = int((time.perf_counter() - t0) * 1000)
    vecs = [e.embedding for e in sorted(resp.data, key=lambda x: x.index)]
    arr  = np.array(vecs, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    arr   = arr / np.maximum(norms, 1e-9)
    return arr, resp.usage.prompt_tokens, duration_ms


def embed_pending(
    conn,
    client: OpenAI,
    batch_size: int = BATCH_SIZE,
    max_age_hours: int | None = 72,
) -> dict:
    """
    Embed articles where title_normalized is set but title_embedding is NULL.
    Updates the DB in place. Returns stats dict.

    Args:
        conn:          open DB connection
        client:        OpenAI client
        batch_size:    items per OpenAI API call
        max_age_hours: only embed articles whose fetched_at is within this window.
                       The published_at filter is intentionally NOT applied here:
                       once normalize_pending has accepted an article into the
                       pipeline, embed should follow regardless of where the
                       rolling published_at window currently sits — otherwise
                       articles normalized in a previous run can fall outside
                       the embed window and become zombies.
                       The fetched_at guard is the only safeguard against
                       backfilling the historical archive (8k+ migrated rows).
                       None disables the time filter (use for historical backfill).
    """
    params: list = []
    query = """
        SELECT id, title_normalized, summary_normalized
        FROM items
        WHERE title_normalized IS NOT NULL
          AND TRIM(title_normalized) <> ''
          AND title_embedding IS NULL
          AND archive_seed = FALSE
    """
    if max_age_hours is not None:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=int(max_age_hours))).isoformat(timespec="seconds")
        query += " AND fetched_at >= %s"
        params.append(cutoff)

    query += " ORDER BY fetched_at DESC"

    cur = conn.cursor()
    cur.execute(query, params)
    rows = cur.fetchall()
    if not rows:
        return {"embedded": 0, "cost": 0.0, "tokens": 0}

    n_total       = len(rows)
    pad           = len(str(n_total))
    total_tokens  = 0
    processed     = 0
    n_no_summary  = 0

    print(f"  Embedding {n_total} article(s) in batches of {batch_size}...")

    for start in range(0, n_total, batch_size):
        batch = rows[start:start + batch_size]

        # Defensive NUL strip: Postgres TEXT rejects 0x00 and the OpenAI API
        # occasionally chokes on stray control bytes too.
        title_texts = [(r[1] or "").replace("\x00", "") for r in batch]
        title_vecs, t_tokens, t_dur_ms = _embed_texts(title_texts, client)
        log_llm_call(
            conn, model=MODEL, step="embed", purpose="title_batch",
            input_tokens=t_tokens, duration_ms=t_dur_ms,
        )

        # Indices within the batch that have a non-empty summary.
        sum_idx   = [i for i, r in enumerate(batch) if r[2] and r[2].strip()]
        sum_texts = [batch[i][2].replace("\x00", "") for i in sum_idx]
        if sum_texts:
            sum_vecs, s_tokens, s_dur_ms = _embed_texts(sum_texts, client)
            log_llm_call(
                conn, model=MODEL, step="embed", purpose="summary_batch",
                input_tokens=s_tokens, duration_ms=s_dur_ms,
            )
        else:
            sum_vecs, s_tokens = None, 0

        # Map batch index → summary vector (or None).
        sum_by_idx: dict[int, np.ndarray] = {}
        if sum_vecs is not None:
            for k, i in enumerate(sum_idx):
                sum_by_idx[i] = sum_vecs[k]

        for i, r in enumerate(batch):
            article_id = r[0]
            # pgvector accepts the same bracketed-comma text format that
            # json.dumps produces — no need for the `pgvector` Python adapter.
            t_str = json.dumps(title_vecs[i].tolist())
            s_vec  = sum_by_idx.get(i)
            s_str = json.dumps(s_vec.tolist()) if s_vec is not None else None
            if s_str is None:
                n_no_summary += 1
            cur.execute(
                """UPDATE items
                   SET title_embedding   = %s::vector(1536),
                       summary_embedding = %s::vector(1536)
                   WHERE id = %s""",
                (t_str, s_str, article_id),
            )
            processed += 1

        total_tokens += t_tokens + s_tokens
        cost_so_far  = estimate_cost(MODEL, input_tokens=total_tokens, output_tokens=0)
        print(f"  [{processed:>{pad}}/{n_total}] embedded ({n_no_summary} without summary)  (${cost_so_far:.4f})")
        conn.commit()  # flush progressively so a crash doesn't lose the whole run

    cost = estimate_cost(MODEL, input_tokens=total_tokens, output_tokens=0)
    return {"embedded": processed, "cost": cost, "tokens": total_tokens}
