import type { Story, Singleton, Article } from "./types";
import { countryToRegion, countryLabel, regionLabel } from "./format";

/**
 * All `count` fields below carry the **same unit**: number of *items*
 * (clusters or singletons) where the entity is mentioned by at least
 * one article. A cluster of 10 articles all from Reuters counts as ONE
 * Reuters mention — not ten — so the counts match what users see in
 * their feed (rows) and align with the tabs (Tout / Non lus / …) and
 * with the per-entity unread badges in the sidebar.
 */

export interface FeedAgg {
  name: string;          // feed_name (e.g., "Reuters - World")
  source: string;        // canonical source (e.g., "Reuters")
  country: string | null;
  region: string;
  count: number;         // items mentioning this feed
}

export interface RegionAgg {
  name: string;
  count: number;         // items with at least one article from this region
}

export interface CountryAgg {
  code: string;       // ISO 2-letter, e.g. "FR"
  label: string;      // Localized FR name, e.g. "France"
  region: string;     // Region this country belongs to
  count: number;      // items with at least one article from this country
}

export interface CategoryAgg {
  name: string;
  count: number;         // items tagged with this category
}

export interface LangAgg {
  code: string;
  count: number;         // items with at least one article in this language
}

export interface EntityAgg {
  /** Canonical entity_id from `entities.id` (BIGINT). Primary key
   *  for filter selection / dedup. */
  entity_id: number;
  /** Wikidata Q-id, e.g. "Q22686". NULL when unlinked. */
  qid: string | null;
  name: string;
  kind: "person" | "org" | "location" | "event" | "market" | "product";
  /** ISO 3166-1 alpha-2 if applicable. */
  country: string | null;
  image_url: string | null;
  description: string | null;
  count: number;         // items mentioning this entity
}

/**
 * "Lieu" — country mentioned in `article.countries` (ISO code) OR free-text
 * location string from `article.entities.locations`. Used by the "Lieux"
 * advanced filter, which mirrors the MVP brief: places concerned by the story,
 * not the publication country.
 */
export interface LieuAgg {
  /** Filter value (ISO code "FR" or raw location "Paris"). */
  key: string;
  /** Display label (localized country name, or the raw location string). */
  label: string;
  /** "country" → matched against article.countries; "location" → entities.locations. */
  kind: "country" | "location";
  /** Items mentioning this place. */
  count: number;
}

export interface Aggregations {
  feeds: FeedAgg[];
  feedsByRegion: Record<string, FeedAgg[]>;
  regions: RegionAgg[];
  /** Countries grouped by region — for the "Origine" sidebar section
   *  (source country = where the feed publishes from). */
  originByRegion: { region: string; total: number; countries: CountryAgg[] }[];
  /** Countries grouped by region — for the "Pays concernés" sidebar section
   *  (article.countries from the normalizer = what the article is ABOUT).
   *  Structured ISO codes, clean by design (no transliteration noise like
   *  entities.locations). */
  subjectCountriesByRegion: { region: string; total: number; countries: CountryAgg[] }[];
  categories: CategoryAgg[];
  langs: LangAgg[];
  /** Legacy combined countries + free-text locations. Still emitted for any
   *  consumer that wants the merged view; the modern sidebar uses
   *  `subjectCountriesByRegion` + the deduped `entities.locations` instead. */
  lieux: LieuAgg[];
  entities: {
    persons: EntityAgg[];
    orgs: EntityAgg[];
    locations: EntityAgg[];
    /** Scheduled events / market instruments / named products
     *  surfaced by the extractor. */
    events: EntityAgg[];
    markets: EntityAgg[];
    products: EntityAgg[];
  };
  total: {
    stories: number;
    singletons: number;
    articles: number;
    feeds: number;
  };
}

// No truncation — consumers (sidebar / dialog) decide how many to display.

/**
 * Per-dimension unread lookup. Same dimensions as `Aggregations` so each
 * sidebar Explore section can read its total *and* its unread badge from
 * the same data shape (no cross-wiring between dimensions, no risk of
 * "unread > total" because both numbers come from the same `aggregate()`
 * applied to two nested universes).
 *
 * Keys mirror exactly what each sidebar section uses for its total
 * lookup, so the consumer never has to think about normalization:
 *  - `feeds`      → feed_name
 *  - `origin`     → ISO source_country (UPPER)
 *  - `subject`    → ISO article-country (UPPER) — what the article is ABOUT
 *  - `categories` → category string (as emitted by normalizer)
 *  - `langs`      → ISO lang code (lower)
 *  - `persons`/.../`products` → `entityKey(name)` (case-folded — see below)
 */
export interface UnreadCounts {
  feeds:      Record<string, number>;
  origin:     Record<string, number>;
  subject:    Record<string, number>;
  categories: Record<string, number>;
  langs:      Record<string, number>;
  persons:    Record<string, number>;
  orgs:       Record<string, number>;
  locations:  Record<string, number>;
  events:     Record<string, number>;
  markets:    Record<string, number>;
  products:   Record<string, number>;
}

/** Entity unread-lookup key. Entities carry a stable `entity_id`
 *  (BIGINT) and we key UnreadCounts by that id (stringified for the
 *  Record<string, number> shape — JS object keys are strings under the
 *  hood). Keying by id rather than by name avoids casing drift.
 *  Helper kept as a function for callers that already have an
 *  EntityAgg / LinkedEntity in hand. */
export const entityKey = (eid: number): string => String(eid);

/**
 * Build a per-dimension `key → count` lookup from an `Aggregations`
 * computed on the unread subset. Sidebar then does
 * `unreadCounts.persons[entityKey(name)]` to get the badge for any row.
 *
 * Note: this expects `aggsUnread` to come from `aggregate(...)` applied
 * to a unread-only subset of stories+singletons — the work of producing
 * that subset lives in the caller, not here.
 */
export function buildUnreadLookup(aggsUnread: Aggregations): UnreadCounts {
  const flat = <T extends { count: number }>(
    items: T[],
    key: (item: T) => string,
  ): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const item of items) {
      const k = key(item);
      if (k) out[k] = (out[k] ?? 0) + item.count;
    }
    return out;
  };
  const allCountries = (
    groups: { countries: CountryAgg[] }[],
  ): CountryAgg[] => groups.flatMap((g) => g.countries);

  return {
    feeds:      flat(aggsUnread.feeds, (f) => f.name),
    origin:     flat(allCountries(aggsUnread.originByRegion), (c) => c.code),
    subject:    flat(allCountries(aggsUnread.subjectCountriesByRegion), (c) => c.code),
    categories: flat(aggsUnread.categories, (c) => c.name),
    langs:      flat(aggsUnread.langs, (l) => l.code),
    persons:    flat(aggsUnread.entities.persons,   (e) => entityKey(e.entity_id)),
    orgs:       flat(aggsUnread.entities.orgs,      (e) => entityKey(e.entity_id)),
    locations:  flat(aggsUnread.entities.locations, (e) => entityKey(e.entity_id)),
    events:     flat(aggsUnread.entities.events,    (e) => entityKey(e.entity_id)),
    markets:    flat(aggsUnread.entities.markets,   (e) => entityKey(e.entity_id)),
    products:   flat(aggsUnread.entities.products,  (e) => entityKey(e.entity_id)),
  };
}

export const EMPTY_UNREAD_COUNTS: UnreadCounts = {
  feeds: {}, origin: {}, subject: {}, categories: {}, langs: {},
  persons: {}, orgs: {}, locations: {}, events: {}, markets: {}, products: {},
};

/** Compute all the aggregations the sidebar needs from a watch payload.
 *
 * Counting unit: every aggregation counts **items** (clusters or
 * singletons), not raw articles. A cluster of 10 Reuters articles
 * counts as ONE Reuters mention so the displayed totals match what a
 * user actually sees in the feed (rows) and what the tab counters /
 * unread badges already report. Entities mentioned multiple times
 * within a single cluster are deduplicated before incrementing.
 *
 * Region names and country labels are pre-localized so the sidebar can
 * render `aggs.regions[i].name` directly. Region keys are kept stable
 * internally; only the user-visible `name` field is translated.
 */
export function aggregate(
  stories: Story[],
  singletons: Singleton[],
  locale: string,
): Aggregations {
  const feeds = new Map<string, FeedAgg>();
  const regions: Record<string, number> = {};
  const countries = new Map<string, CountryAgg>(); // by ISO code (source_country)
  const categories: Record<string, number> = {};
  const langs: Record<string, number> = {};
  // Entity aggs keyed by entity_id (BIGINT). Value carries the metadata
  // captured on first sighting plus the running mention count. The
  // metadata is stable across items so first-write-wins is fine.
  type EntityAccum = {
    entity_id:   number;
    qid:         string | null;
    name:        string;
    kind:        EntityAgg["kind"];
    country:     string | null;
    image_url:   string | null;
    description: string | null;
    count:       number;
  };
  const persons:   Map<number, EntityAccum> = new Map();
  const orgs:      Map<number, EntityAccum> = new Map();
  const locations: Map<number, EntityAccum> = new Map();
  const events:    Map<number, EntityAccum> = new Map();
  const markets:   Map<number, EntityAccum> = new Map();
  const products:  Map<number, EntityAccum> = new Map();
  // Article-level countries (countries the story is *about*, not where published).
  const articleCountries: Record<string, number> = {};
  let articleCount = 0;

  /** Tally one item. Builds the set of distinct entities mentioned by
   *  any article in the cluster, then bumps each aggregation by 1.
   *  First-seen feeds and countries also capture a representative
   *  article so we can seed their metadata (source name, region). */
  const tallyItem = (articles: Article[]) => {
    if (articles.length === 0) return;
    const seenFeeds = new Map<string, Article>();
    const seenRegions = new Set<string>();
    const seenCountries = new Map<string, string>();   // ISO code → region
    const seenCategories = new Set<string>();
    const seenLangs = new Set<string>();
    // Entity dedup keyed by entity_id. Each kind tracks (entity_id ->
    // metadata) for first-seen → so we can carry the canonical
    // qid/name/country/etc. when bumping into the per-kind accumulator.
    const seenEntities: Record<EntityAgg["kind"], Map<number, EntityAccum>> = {
      person:   new Map(),
      org:      new Map(),
      location: new Map(),
      event:    new Map(),
      market:   new Map(),
      product:  new Map(),
    };
    const seenArticleCountries = new Set<string>();

    for (const a of articles) {
      articleCount++;

      const feedKey = a.feed_name || a.source;
      if (feedKey && !seenFeeds.has(feedKey)) seenFeeds.set(feedKey, a);

      const region = regionLabel(countryToRegion(a.source_country), locale);
      seenRegions.add(region);

      if (a.source_country) {
        const code = a.source_country.toUpperCase();
        if (!seenCountries.has(code)) seenCountries.set(code, region);
      }

      for (const c of a.category ?? []) seenCategories.add(c);
      if (a.lang) seenLangs.add(a.lang);

      // Linked entities — a flat list.
      for (const ent of a.entities ?? []) {
        if (!ent || typeof ent.entity_id !== "number") continue;
        const bucket = seenEntities[ent.kind];
        if (!bucket || bucket.has(ent.entity_id)) continue;
        bucket.set(ent.entity_id, {
          entity_id:   ent.entity_id,
          qid:         ent.qid,
          name:        ent.name,
          kind:        ent.kind,
          country:     ent.country,
          image_url:   ent.image_url,
          description: ent.description,
          count:       0,  // bumped at item-level below
        });
      }

      for (const c of a.countries ?? []) {
        seenArticleCountries.add(c.toUpperCase());
      }
    }

    for (const [feedKey, rep] of seenFeeds) {
      let f = feeds.get(feedKey);
      if (!f) {
        f = {
          name: feedKey,
          source: rep.source,
          country: rep.source_country,
          region: regionLabel(countryToRegion(rep.source_country), locale),
          count: 0,
        };
        feeds.set(feedKey, f);
      }
      f.count++;
    }

    for (const r of seenRegions) {
      regions[r] = (regions[r] ?? 0) + 1;
    }

    for (const [code, region] of seenCountries) {
      let entry = countries.get(code);
      if (!entry) {
        entry = { code, label: countryLabel(code, locale), region, count: 0 };
        countries.set(code, entry);
      }
      entry.count++;
    }

    for (const c of seenCategories) categories[c] = (categories[c] ?? 0) + 1;
    for (const l of seenLangs)      langs[l]      = (langs[l]      ?? 0) + 1;

    // Bump entity accumulators by entity_id, carrying the per-item
    // metadata into the global Map on first sighting.
    const bumpEntity = (
      target: Map<number, EntityAccum>,
      seen: Map<number, EntityAccum>,
    ): void => {
      for (const [eid, meta] of seen) {
        const existing = target.get(eid);
        if (existing) {
          existing.count++;
        } else {
          target.set(eid, { ...meta, count: 1 });
        }
      }
    };
    bumpEntity(persons,   seenEntities.person);
    bumpEntity(orgs,      seenEntities.org);
    bumpEntity(locations, seenEntities.location);
    bumpEntity(events,    seenEntities.event);
    bumpEntity(markets,   seenEntities.market);
    bumpEntity(products,  seenEntities.product);

    for (const c of seenArticleCountries) {
      articleCountries[c] = (articleCountries[c] ?? 0) + 1;
    }
  };

  for (const s of stories) tallyItem(s.articles);
  for (const a of singletons) tallyItem([a]);

  const sortedFeeds = [...feeds.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, locale),
  );

  const feedsByRegion: Record<string, FeedAgg[]> = {};
  for (const f of sortedFeeds) {
    (feedsByRegion[f.region] ??= []).push(f);
  }

  // Origine = countries grouped by region, with totals.
  const countriesByRegion: Record<string, CountryAgg[]> = {};
  for (const c of [...countries.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label, locale),
  )) {
    (countriesByRegion[c.region] ??= []).push(c);
  }
  // Region total comes from the per-region tally, NOT a sum of per-country
  // counts. A single item with articles from 3 different countries in the
  // same region (e.g. a story syndicated across FR, BE, ES feeds) would
  // be triple-counted by summing — the dedup region map already collapses
  // it to one mention.
  const originByRegion = Object.entries(countriesByRegion)
    .map(([region, countries]) => ({
      region,
      total: regions[region] ?? 0,
      countries,
    }))
    .sort((a, b) => b.total - a.total);

  const sortedDict = (d: Record<string, number>) =>
    Object.entries(d)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));

  // Lieux = article-level countries (ISO codes, labeled) + free-text locations,
  // both sorted together by count desc. Mirrors the MVP brief's "Lieux" pills.
  //
  // Dedup by key: when a free-text location string collides with an ISO
  // country code already present (e.g. the LLM extracted "CU" both as a
  // country AND as a free-text place), we merge counts under the country
  // entry. Without this we'd emit two items with the same `key`, and
  // React's reconciler would skip or duplicate the corresponding pill —
  // a non-unique-key warning that has caused visible layout regressions
  // in dialogs (the warning collapses the surrounding subtree).
  const lieuxByKey = new Map<string, LieuAgg>();
  for (const [code, count] of Object.entries(articleCountries)) {
    lieuxByKey.set(code, {
      key: code,
      label: countryLabel(code, locale) || code,
      kind: "country",
      count,
    });
  }
  for (const [name, count] of Object.entries(locations)) {
    const existing = lieuxByKey.get(name);
    if (existing) {
      existing.count += count;
    } else {
      lieuxByKey.set(name, {
        key: name,
        label: name,
        kind: "location",
        count,
      });
    }
  }
  const lieux: LieuAgg[] = [...lieuxByKey.values()].sort(
    (a, b) => b.count - a.count,
  );

  // Subject countries — article.countries from the normalizer, grouped by
  // region the same way Origine is. Clean by design: ISO codes only, no
  // transliteration variants. Region totals sum the per-country counts;
  // double-counting a single item that mentions FR + DE in the same region
  // is acceptable noise at sidebar resolution.
  const subjectCountriesByCode = new Map<string, CountryAgg>();
  for (const [code, count] of Object.entries(articleCountries)) {
    const region = regionLabel(countryToRegion(code), locale);
    subjectCountriesByCode.set(code, {
      code,
      label: countryLabel(code, locale) || code,
      region,
      count,
    });
  }
  const subjectCountriesByRegionMap: Record<string, CountryAgg[]> = {};
  for (const c of [...subjectCountriesByCode.values()].sort((a, b) => b.count - a.count)) {
    (subjectCountriesByRegionMap[c.region] ??= []).push(c);
  }
  const subjectCountriesByRegion = Object.entries(subjectCountriesByRegionMap)
    .map(([region, countries]) => ({
      region,
      total: countries.reduce((s, c) => s + c.count, 0),
      countries,
    }))
    .sort((a, b) => b.total - a.total);

  // Canonical Wikidata-backed entities are deduplicated by `entity_id`
  // at insert time, so no case-fold dedup is needed. Just sort by count DESC + name ASC for
  // deterministic order.
  const emitEntities = (accum: Map<number, EntityAccum>): EntityAgg[] =>
    [...accum.values()]
      .map((e): EntityAgg => ({
        entity_id:   e.entity_id,
        qid:         e.qid,
        name:        e.name,
        kind:        e.kind,
        country:     e.country,
        image_url:   e.image_url,
        description: e.description,
        count:       e.count,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, locale));

  return {
    feeds: sortedFeeds,
    feedsByRegion,
    regions: sortedDict(regions),
    originByRegion,
    subjectCountriesByRegion,
    categories: sortedDict(categories),
    langs: Object.entries(langs)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    lieux,
    entities: {
      persons:   emitEntities(persons),
      orgs:      emitEntities(orgs),
      locations: emitEntities(locations),
      events:    emitEntities(events),
      markets:   emitEntities(markets),
      products:  emitEntities(products),
    },
    total: {
      stories: stories.length,
      singletons: singletons.length,
      articles: articleCount,
      feeds: feeds.size,
    },
  };
}
