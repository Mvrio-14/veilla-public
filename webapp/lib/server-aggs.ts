/**
 * Server-side sidebar aggregations adapter.
 *
 * Converts the flat `ServerAggs` payload returned by /watch into the
 * `Aggregations` shape consumed by Sidebar / ListPanel / ViewEditDialog
 * (= the same shape `aggregate()` in `lib/aggregate.ts` returns when
 * computing client-side). The server doesn't know the viewer's locale,
 * so country/region/lang labels are derived here at render time.
 *
 * Companion output `UnreadCounts` mirrors the structure used by the
 * Sidebar's per-row unread badges, so server-provided and client-computed
 * unread counts flow into the same prop.
 *
 * # Scope
 *
 * Server aggs cover the FULL universe of the user's /watch payload
 * (no Advanced dialog applied). They map 1-1 to the client
 * `aggregate(data.stories, data.singletons)` output — used by
 * FilterPicker + ListPanel "Tous (N)" badges.
 */
import {
  EMPTY_UNREAD_COUNTS,
  entityKey,
  type Aggregations,
  type CountryAgg,
  type EntityAgg,
  type FeedAgg,
  type UnreadCounts,
} from "./aggregate";
import { countryToRegion, regionLabel, countryLabel } from "./format";
import type { ServerAggs, ServerEntityAgg } from "./types";


function groupCountriesByRegion(
  rows: { code: string; count: number; unread: number }[],
  locale: string,
): { region: string; total: number; countries: CountryAgg[] }[] {
  const buckets: Record<string, CountryAgg[]> = {};
  const regionTotals: Record<string, number> = {};
  for (const row of rows) {
    const region = regionLabel(countryToRegion(row.code), locale);
    (buckets[region] ??= []).push({
      code:   row.code,
      label:  countryLabel(row.code, locale) || row.code,
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


function entityRows(rows: ServerEntityAgg[]): EntityAgg[] {
  // Server already returns canonical entity rows sorted by (-count,
  // name). Adapter just renames to match the client EntityAgg shape
  // (= structurally identical post-migration).
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


function unreadLookup(
  rows: { count: number; unread: number; key?: string; name?: string; code?: string }[],
  keyField: "key" | "name" | "code",
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r[keyField];
    if (typeof k !== "string" || !k) continue;
    out[k] = r.unread;
  }
  return out;
}


/**
 * Convert the server payload into the client-side aggregations + unread
 * lookups. The returned `aggs` is structurally compatible with the
 * `Aggregations` interface produced by `aggregate()` and can be dropped
 * straight into the existing prop shapes.
 */
export function fromServerAggs(
  s: ServerAggs,
  locale: string,
): { aggs: Aggregations; unreadCounts: UnreadCounts } {
  // ── Aggregations ─────────────────────────────────────────────────
  const feeds: FeedAgg[] = s.feeds.map((f) => ({
    name:    f.name,
    source:  f.source ?? f.name,
    country: f.country,
    region:  regionLabel(countryToRegion(f.country), locale),
    count:   f.count,
  }));

  const feedsByRegion: Record<string, FeedAgg[]> = {};
  for (const f of feeds) {
    (feedsByRegion[f.region] ??= []).push(f);
  }

  // Region totals from feeds (best proxy when computing from server data);
  // FilterPicker doesn't currently consume `regions` heavily — kept here
  // for type completeness so anything that imports `aggs.regions` doesn't
  // hit undefined.
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
    originByRegion:           groupCountriesByRegion(s.origin_countries, locale),
    subjectCountriesByRegion: groupCountriesByRegion(s.subject_countries, locale),
    categories: s.categories.map((c) => ({ name: c.name, count: c.count })),
    langs:      s.langs.map((l) => ({ code: l.code, count: l.count })),
    // `lieux` (= combined country + raw location list) is unused by the
    // sidebar; we leave it empty. ViewEditDialog reads it only for
    // fallback rendering.
    lieux: [],
    entities: {
      persons:   entityRows(s.entities.persons),
      orgs:      entityRows(s.entities.orgs),
      locations: entityRows(s.entities.locations),
      events:    entityRows(s.entities.events),
      markets:   entityRows(s.entities.markets),
      products:  entityRows(s.entities.products),
    },
    total: s.total,
  };

  // ── UnreadCounts ─────────────────────────────────────────────────
  // Mirrors `buildUnreadLookup` in lib/aggregate.ts. Server already
  // emits the case-folded `key` for entities, so lookups in the Sidebar
  // continue to work via `entityKey(name)` on the client.
  void entityKey; // ensure import stays even if unused at runtime here
  const unreadCounts: UnreadCounts = {
    ...EMPTY_UNREAD_COUNTS,
    feeds:      unreadLookup(s.feeds, "name"),
    langs:      unreadLookup(s.langs, "code"),
    origin:     unreadLookup(s.origin_countries, "code"),
    subject:    unreadLookup(s.subject_countries, "code"),
    categories: unreadLookup(s.categories, "name"),
    persons:    unreadLookup(s.entities.persons, "key"),
    orgs:       unreadLookup(s.entities.orgs, "key"),
    locations:  unreadLookup(s.entities.locations, "key"),
    events:     unreadLookup(s.entities.events, "key"),
    markets:    unreadLookup(s.entities.markets, "key"),
    products:   unreadLookup(s.entities.products, "key"),
  };

  return { aggs, unreadCounts };
}
