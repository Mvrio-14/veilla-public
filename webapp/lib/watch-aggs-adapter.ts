/**
 * Adapter: WatchAggregations (/watch/aggregations) → Aggregations (sidebar shape).
 *
 * The `/users/{slug}/watch/aggregations` endpoint returns a leaner,
 * drill-down-aware payload than the `aggs_server` that ships embedded
 * in /watch. This module bridges that shape into the `Aggregations`
 * interface the Sidebar / ListPanel / ViewEditDialog consume, so both
 * sources feed the same props.
 *
 * # What's different from `fromServerAggs`
 *
 * - Entries are `{value, count}` instead of `{name|code|key, count, unread}`.
 *   No per-row `unread` here — the endpoint exposes unread at the
 *   `by_quick_filter` level (a single aggregate count). Per-row unread
 *   badges would require a second aggregations call with
 *   `quick_filter=unread`; we drop them rather than double the request
 *   count.
 * - Feeds carry only the name; we enrich with country via a lookup
 *   against `WatchUniverse.feeds`, so the existing region-grouping in
 *   the sidebar keeps working.
 * - Entity rows arrive already case-folded and deduped server-side, so
 *   the adapter does not re-run `entityKey()`.
 *
 * # When this is called vs `fromServerAggs`
 *
 * WatchMain decides at render time which path to use:
 *   - Hook `useWatchAggs` returned fresh data → this adapter.
 *   - Otherwise fall back to `fromServerAggs(aggs_server)`
 *     for the SSR-served initial state, OR client-side `aggregate()` if
 *     neither is available.
 */
import type { WatchAggregations } from "./actions";
import {
  EMPTY_UNREAD_COUNTS,
  type Aggregations,
  type CountryAgg,
  type FeedAgg,
  type EntityAgg,
  type UnreadCounts,
} from "./aggregate";
import { countryToRegion, regionLabel, countryLabel } from "./format";
import type { WatchUniverse } from "./types";


function groupCountriesByRegion(
  rows:   { value: string; count: number }[],
  locale: string,
): { region: string; total: number; countries: CountryAgg[] }[] {
  const buckets: Record<string, CountryAgg[]> = {};
  const regionTotals: Record<string, number> = {};
  for (const row of rows) {
    const region = regionLabel(countryToRegion(row.value), locale);
    (buckets[region] ??= []).push({
      code:   row.value,
      label:  countryLabel(row.value, locale) || row.value,
      region,
      count:  row.count,
    });
    regionTotals[region] = (regionTotals[region] ?? 0) + row.count;
  }
  return Object.entries(buckets)
    .map(([region, countries]) => ({
      region,
      total: regionTotals[region] ?? 0,
      countries: countries.sort(
        (a, b) => b.count - a.count || a.label.localeCompare(b.label, locale),
      ),
    }))
    .sort((a, b) => b.total - a.total);
}


function entityRows(rows: import("./actions").ServerEntityFacetRow[]): EntityAgg[] {
  // Server already returns canonical entity rows.
  // Adapter passes through the full metadata so the sidebar can render
  // avatars / flags / descriptions inline.
  return rows.map((e) => ({
    entity_id:   e.entity_id,
    qid:         e.qid,
    name:        e.name,
    kind:        e.kind,
    country:     e.country,
    image_url:   e.image_url,
    description: e.description,
    count:       e.count,
  }));
}


/**
 * Build the client-side `Aggregations` from the new aggregations endpoint.
 *
 * @param w         the WatchAggregations payload
 * @param universe  the WatchUniverse from /watch (used to map feed name →
 *                  country). Pass null when not available — feed rows then
 *                  fall back to "(unknown)" region.
 * @param locale    user's UI locale, drives country/region label resolution
 */
export function fromWatchAggregations(
  w:        WatchAggregations,
  universe: WatchUniverse | null | undefined,
  locale:   string,
): { aggs: Aggregations; unreadCounts: UnreadCounts } {
  // Feed name → country lookup, derived once from universe. Resolving on
  // every row instead would be O(n*m) — universe has up to ~150 feeds,
  // not big, but the lookup is hit every render so we cache it.
  const feedCountryByName: Record<string, string | null> = {};
  if (universe) {
    for (const f of universe.feeds) {
      feedCountryByName[f.name] = f.country;
    }
  }

  // ── Feeds ──
  const feeds: FeedAgg[] = w.by_feeds.map((f) => {
    const country = feedCountryByName[f.value] ?? null;
    const region  = regionLabel(countryToRegion(country ?? ""), locale);
    return {
      name:    f.value,
      source:  f.value,        // No source-vs-feed split in the new payload.
      country,
      region,
      count:   f.count,
    };
  });

  const feedsByRegion: Record<string, FeedAgg[]> = {};
  for (const f of feeds) {
    (feedsByRegion[f.region] ??= []).push(f);
  }

  const regionsTotals: Record<string, number> = {};
  for (const f of feeds) {
    regionsTotals[f.region] = (regionsTotals[f.region] ?? 0) + f.count;
  }
  const regions = Object.entries(regionsTotals)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));

  const aggs: Aggregations = {
    feeds,
    feedsByRegion,
    regions,
    originByRegion:           groupCountriesByRegion(w.by_source_countries, locale),
    subjectCountriesByRegion: groupCountriesByRegion(w.by_subject_countries, locale),
    categories: w.by_categories.map((c) => ({ name: c.value, count: c.count })),
    langs:      w.by_langs.map((l)      => ({ code: l.value, count: l.count })),
    lieux:      [],   // unused by the sidebar (= same as fromServerAggs)
    entities: {
      persons:   entityRows(w.by_entity_persons),
      orgs:      entityRows(w.by_entity_orgs),
      locations: entityRows(w.by_entity_locations),
      events:    entityRows(w.by_entity_events),
      markets:   entityRows(w.by_entity_markets),
      products:  entityRows(w.by_entity_products),
    },
    // Best-effort total: the endpoint reports a single `total_count`
    // of visible items (= stories + singletons). The `total` shape has
    // a finer breakdown that the sidebar code doesn't actually consume
    // — we approximate by lumping everything under `stories`.
    total: {
      stories:    w.total_count,
      singletons: 0,
      articles:   0,
      feeds:      w.by_feeds.length,
    },
  };

  // No per-row unread badges in this payload. Sidebar still renders the
  // primary count badges; per-row unread chips just stay empty until we
  // either add a second aggregations call or push unread counts into
  // the same query.
  const unreadCounts: UnreadCounts = { ...EMPTY_UNREAD_COUNTS };

  return { aggs, unreadCounts };
}
