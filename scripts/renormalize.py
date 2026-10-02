"""
One-off script to force re-normalization of already-normalized articles.
Useful after updating the normalizer / extractor prompt.

Two LLM calls per article:
  - re-runs Call A (normalizer) → title_normalized + summary_normalized
    + summary_full + lang
  - re-runs Call B (extractor)  → category + keywords + countries +
    entities + article_type

Both calls execute sequentially per article. Pass --normalize-only or
--extract-only to skip one side (e.g. only re-running extraction after
an extractor prompt tweak, without paying for re-translation).

Only the items delivered by the user's monitors are re-run.

Usage:
    python scripts/renormalize.py --hours 16 --user <user-slug>
    python scripts/renormalize.py --hours 16 --user <user-slug> --dry-run
    python scripts/renormalize.py --hours 16 --user <user-slug> --extract-only
"""
import argparse
import sys
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

sys.path.insert(0, str(Path(__file__).parent.parent))
from src.db import get_connection
from src.extractor import _extract_one
from src.llm_costs import estimate_cost
from src.monitors import get_user_monitor_ids
from src.normalizer import MODEL, _normalize_one

load_dotenv()


def _resolve_user_id(conn, user_slug: str) -> str:
    """Look up the user UUID from the slug; abort if not found."""
    cur = conn.cursor()
    cur.execute("SELECT id FROM users WHERE slug = %s", (user_slug,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"User slug {user_slug!r} not found in `users` table.")
    return str(row[0])


def renormalize(hours: int, user_slug: str, dry_run: bool,
                do_normalize: bool, do_extract: bool):
    conn   = get_connection()
    client = OpenAI()

    from datetime import datetime, timedelta, timezone
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()

    user_id     = _resolve_user_id(conn, user_slug)
    monitor_ids = get_user_monitor_ids(conn, user_id)
    if not monitor_ids:
        print(f"User {user_slug!r} has no subscribed monitors — nothing to do.")
        return

    cur = conn.cursor()
    cur.execute("""
        SELECT a.id, a.title, a.summary, s.country, s.name
        FROM items a
        LEFT JOIN sources s ON s.id = a.source_id
        WHERE a.title_normalized IS NOT NULL
          AND COALESCE(a.published_at, a.fetched_at) >= %s
          AND EXISTS (
              SELECT 1 FROM monitor_items mi
              WHERE mi.item_id = a.id AND mi.monitor_id = ANY(%s)
          )
        ORDER BY COALESCE(a.published_at, a.fetched_at) DESC
    """, (cutoff, monitor_ids))
    rows = cur.fetchall()

    if not rows:
        print("No articles found.")
        return

    n_total  = len(rows)
    dry_tag  = " (dry-run)" if dry_run else ""
    pad      = len(str(n_total))
    mode = []
    if do_normalize: mode.append("normalize")
    if do_extract:   mode.append("extract")
    print(f"Articles to re-{'+ '.join(mode)}: {n_total}{dry_tag}")

    total_in = total_out = updated = 0
    for i, row in enumerate(rows, 1):
        article = {
            "id":             row[0],
            "title":          row[1],
            "summary":        row[2] or "",
            "source_country": row[3],
            "source_name":    row[4],
        }
        norm_out: dict = {}
        extr_out: dict = {}

        if do_normalize:
            norm_out = _normalize_one(article, client)
            total_in  += norm_out["input_tokens"]
            total_out += norm_out["output_tokens"]
            article["title_normalized"]   = norm_out["title_normalized"]
            article["summary_normalized"] = norm_out["summary_normalized"]
            article["summary_full"]       = norm_out["summary_full"]
            article["lang"]               = norm_out["lang"]
        else:
            # Re-extract using already-stored fields. Fetch them lazily.
            cur.execute(
                "SELECT title_normalized, summary_normalized, summary_full, lang "
                "FROM items WHERE id = %s",
                (article["id"],),
            )
            (tn, sn, sf, lg) = cur.fetchone()
            article["title_normalized"]   = tn
            article["summary_normalized"] = sn
            article["summary_full"]       = sf
            article["lang"]               = lg

        if do_extract:
            extr_out = _extract_one(article, client)
            total_in  += extr_out["input_tokens"]
            total_out += extr_out["output_tokens"]

        if not dry_run:
            sets: list[str] = []
            params: list = []
            if do_normalize:
                sets += [
                    "title = %s", "title_normalized = %s",
                    "summary_normalized = %s", "summary_full = %s",
                    "lang = COALESCE(%s, lang)",
                ]
                params += [
                    norm_out["title"], norm_out["title_normalized"],
                    norm_out["summary_normalized"], norm_out["summary_full"],
                    norm_out["lang"],
                ]
            if do_extract:
                sets += [
                    "category = %s", "keywords = %s", "countries = %s",
                    "entities = %s", "article_type = %s",
                ]
                params += [
                    extr_out["category"], extr_out["keywords"],
                    extr_out["countries"], extr_out["entities"],
                    extr_out["article_type"],
                ]
            params.append(article["id"])
            cur.execute(
                f"UPDATE items SET {', '.join(sets)} WHERE id = %s",
                params,
            )
            updated += 1

        cost_so_far = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
        title_preview = (norm_out.get("title_normalized") or article.get("title_normalized") or "")[:60]
        print(f"  [{i:>{pad}}/{n_total}] {title_preview}  (${cost_so_far:.4f})")
        if do_extract:
            print(f"    type: {extr_out.get('article_type')} | lang: {article.get('lang')}")

    if not dry_run:
        conn.commit()

    cost = estimate_cost(MODEL, input_tokens=total_in, output_tokens=total_out)
    print(f"\nDone — {updated} updated | cost ${cost:.4f}")
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours",          type=int, required=True, help="Lookback window in hours")
    parser.add_argument("--user",           type=str, required=True, help="User slug")
    parser.add_argument("--dry-run",        action="store_true",     help="Print results without updating DB")
    parser.add_argument("--normalize-only", action="store_true",     help="Skip the extractor pass (Call B)")
    parser.add_argument("--extract-only",   action="store_true",     help="Skip the normalizer pass (Call A)")
    args = parser.parse_args()

    do_normalize = not args.extract_only
    do_extract   = not args.normalize_only
    if not (do_normalize or do_extract):
        raise SystemExit("Both --normalize-only and --extract-only set — nothing to do.")

    renormalize(args.hours, args.user, args.dry_run, do_normalize, do_extract)
