/**
 * Story-level metadata aggregations.
 *
 * The normalizer extracts entities (persons/orgs/locations) and countries
 * per article. The API exposes them on `Article` but doesn't compute a
 * story-level rollup — we do it client-side because:
 *  - It's cheap (≤30 articles × small string arrays).
 *  - It keeps the backend pipeline simple.
 *  - It lets us filter to the articles currently shown without a
 *    separate server-side call.
 *
 * Rule of thumb:
 *  - Item must appear in **at least 2** articles to be considered "part
 *    of the story" rather than an incidental mention.
 *  - When the story has only 1 or 2 articles, drop the threshold to 1 —
 *    otherwise the panel would be empty on small clusters.
 *  - Cap at **top 10** per entity-type / for countries, ranked by count
 *    desc then alphabetically for tie-breaks.
 *
 * Returned counts let the UI render `Macron · 5` so the reader sees how
 * dominant each item is.
 */

import type { Article } from "./types";

export interface RankedItem {
  label: string;
  count: number;
}

export interface AggregatedEntities {
  persons: RankedItem[];
  orgs: RankedItem[];
  locations: RankedItem[];
  /** Scheduled events / market instruments / named products. Same
   *  ranking semantics as the three buckets above. */
  events: RankedItem[];
  markets: RankedItem[];
  products: RankedItem[];
}

const TOP_N = 10;

/**
 * Threshold = 2 in general, 1 when the story is small enough that the
 * threshold would zero-out the panel.
 */
function minCount(nArticles: number): number {
  return nArticles >= 3 ? 2 : 1;
}

/**
 * Tally a list of label arrays into a count map. Trims whitespace and
 * drops empties. Case-folds for dedup ("Gold" / "gold" / "GOLD" collapse
 * to one entry) while preserving the cleanest casing seen for display.
 */
function tally(lists: Iterable<string[] | null | undefined>): Map<string, number> {
  // Key by lowercase; value carries the preferred display label + count.
  const merged = new Map<string, { label: string; count: number }>();
  for (const list of lists) {
    if (!list) continue;
    // Dedupe within a single article (cheap guard against repeated entries
    // in the same article's payload).
    const seenInArticle = new Set<string>();
    for (const raw of list) {
      const label = (raw ?? "").trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seenInArticle.has(key)) continue;
      seenInArticle.add(key);
      const existing = merged.get(key);
      if (existing) {
        existing.count += 1;
        // Prefer a label with at least one uppercase letter over an
        // all-lowercase one (sloppy mid-sentence mentions).
        if (/[A-Z]/.test(label) && !/[A-Z]/.test(existing.label)) {
          existing.label = label;
        }
      } else {
        merged.set(key, { label, count: 1 });
      }
    }
  }
  // Flatten to label→count for the rank() helper that expects a Map.
  const out = new Map<string, number>();
  for (const { label, count } of merged.values()) {
    out.set(label, count);
  }
  return out;
}

/**
 * Filter to entries meeting the threshold, sort desc by count then
 * asc by label (stable display order), and cap.
 */
function rank(counts: Map<string, number>, threshold: number): RankedItem[] {
  const out: RankedItem[] = [];
  for (const [label, count] of counts.entries()) {
    if (count >= threshold) out.push({ label, count });
  }
  out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return out.slice(0, TOP_N);
}

/**
 * Aggregate entities across the story's articles. Returns rankings for
 * persons / orgs / locations independently — they share the same
 * threshold but each gets its own top-10 cap.
 */
export function aggregateStoryEntities(articles: Article[]): AggregatedEntities {
  const threshold = minCount(articles.length);
  // article.entities is a flat LinkedEntity[].
  // Group by kind, then tally by canonical entity name.
  const namesOfKind = (kind: string): (string[] | undefined)[] =>
    articles.map((a) =>
      (a.entities ?? []).filter((e) => e.kind === kind).map((e) => e.name),
    );
  const persons   = tally(namesOfKind("person"));
  const orgs      = tally(namesOfKind("org"));
  const locations = tally(namesOfKind("location"));
  const events    = tally(namesOfKind("event"));
  const markets   = tally(namesOfKind("market"));
  const products  = tally(namesOfKind("product"));
  return {
    persons:   rank(persons,   threshold),
    orgs:      rank(orgs,      threshold),
    locations: rank(locations, threshold),
    events:    rank(events,    threshold),
    markets:   rank(markets,   threshold),
    products:  rank(products,  threshold),
  };
}

/**
 * Aggregate countries across the story's articles. Countries are short
 * codes (ISO alpha-2 or our regional codes like EU/AS/ME/AF/LAT/OCE);
 * the UI resolves to localized labels at render time.
 */
export function aggregateStoryCountries(articles: Article[]): RankedItem[] {
  const threshold = minCount(articles.length);
  const counts = tally(articles.map((a) => a.countries));
  return rank(counts, threshold);
}

/**
 * "Story age" in a coarse-grained label suited for the detail panel info
 * strip ("just now" / "today" / "3d ago" / "2w ago"). Mirrors the cluster
 * card's relative time conventions without depending on a date-fns import.
 *
 * Takes an ISO timestamp string. Returns "" if we can't parse it (e.g.
 * the story has no articles yet — shouldn't happen but guards the call
 * site).
 */
export function relativeAge(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "";
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const fr = locale.startsWith("fr");
  if (minutes < 1) return fr ? "à l'instant" : "just now";
  if (minutes < 60) return fr ? `il y a ${minutes} min` : `${minutes}m ago`;
  if (hours < 24) return fr ? `il y a ${hours} h` : `${hours}h ago`;
  if (days < 7) return fr ? `il y a ${days} j` : `${days}d ago`;
  if (weeks < 5) return fr ? `il y a ${weeks} sem.` : `${weeks}w ago`;
  // Beyond 5 weeks: fall back to the absolute date.
  const date = new Date(t);
  return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
}
