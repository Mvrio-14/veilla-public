/**
 * Watch query serialization — TS counterpart of `src/watch_query.py`.
 *
 * The backend's /users/{slug}/watch and /watch/aggregations endpoints accept
 * a flat bag of query params that map 1:1 onto the Python QueryState fields.
 * This module is the single place those params get assembled, so the two
 * fetchers (page + aggs) and any future deep-link / URL-sync code share
 * exactly the same wire format.
 *
 * # Why no new TS type
 *
 * The SPA's existing in-memory shape is `Advanced` (from `lib/filter.ts`).
 * It already covers every field the backend needs except for three
 * dimensions: scope, quick_filter, and period_hours. Rather than fork a
 * parallel QueryState type and translate at every read site, we keep
 * Advanced as the canonical SPA state and pass the three extras alongside
 * to the serializer.
 *
 * # Period unit
 *
 * Backend expects `period_hours`. Saved views and preferences store
 * `periodMinutes`. Conversion happens at the boundary via
 * `periodMinutesToHours()` — ceiling so a 90-min pref maps to 2h.
 */
import type { Advanced } from "./filter";


/** The story-type scope tabs the SPA shows (Tous / Communs / Originaux).
 *  Maps to the backend's `scope` query param. Note the spelling shift: the
 *  legacy paginator param is `item_type` with French values (`communs` /
 *  `originaux`); the new `scope` param uses English (`common` / `original`). */
export type Scope = "all" | "common" | "original";

/** Per-user quick filter tabs (Tout / Non lus / Sauvegardes / Ignorées). */
export type QuickFilter = "all" | "unread" | "saved" | "ignored";

/** Hard cap matching `MAX_PERIOD_HOURS` in `src/watch_query.py`. The SPA
 *  validates client-side so an out-of-range slider doesn't 422 the API. */
export const MAX_PERIOD_HOURS = 720;
export const MIN_PERIOD_HOURS = 1;


/** Convert the saved-view `periodMinutes` field to the backend's
 *  `period_hours` unit. Ceiling so a 90-min pref maps to 2h, mirroring
 *  the server-side conversion in `api.py`. Returns `null` when
 *  periodMinutes is 0 (= "no time limit" in the saved view), letting
 *  the caller use a different default (typically 24h). */
export function periodMinutesToHours(periodMinutes: number): number | null {
  if (!periodMinutes || periodMinutes <= 0) return null;
  return Math.max(
    MIN_PERIOD_HOURS,
    Math.min(MAX_PERIOD_HOURS, Math.ceil(periodMinutes / 60)),
  );
}


/** All inputs the SPA needs to fully describe a Watch query to the
 *  server. `Advanced` carries the multi-value filters; the three other
 *  fields are the SPA's tab/state dimensions, also resolved server-side. */
export interface WatchQueryInputs {
  advanced:     Advanced;
  scope:        Scope;
  quickFilter:  QuickFilter;
  /** Hours, 1..720. Resolves the saved view's periodMinutes if any,
   *  else the SPA's active window selection, else the default. */
  periodHours:  number;
  /** Default false. Active stories only matches the live-feed UX. */
  includeClosed?: boolean;
  /** Lucene-syntax Boolean filter. When set + non-empty, the
   *  serializer sends it AS `criteria_text` and skips the per-field
   *  entity / category / lang / etc. params — the backend resolver
   *  short-circuits to the compiled Boolean WHERE in that case.
   *  Populated by `watch-main.tsx` when the active saved view was
   *  composed in Boolean mode (`view.criteria_text` non-empty). */
  criteriaText?: string;
}


/** Default WatchQueryInputs for a "fresh" Watch view — empty filters,
 *  default 24h window, "all" tabs. Used as the initial state of
 *  `watch-main.tsx`'s queryState reducer. */
export function defaultWatchInputs(advanced: Advanced): WatchQueryInputs {
  return {
    advanced,
    scope:        "all",
    quickFilter:  "all",
    periodHours:  24,
    includeClosed: false,
  };
}


/**
 * Serialize the SPA's watch state into the URLSearchParams shape the
 * backend expects. Empty / default values are skipped so the URL stays
 * tidy ("don't ship every field every request").
 *
 * Lists become repeated params (FastAPI binds them automatically):
 *   { keywords: ["a", "b"] } → "keywords=a&keywords=b"
 *
 * @param inputs   The SPA's WatchQueryInputs
 * @param extras   Optional non-filter params (cursor / limit / item_type /
 *                 window_hours) that callers append. Kept separate from
 *                 the filter set so the serializer stays single-purpose.
 */
export function serializeWatchParams(
  inputs: WatchQueryInputs,
  extras: Record<string, string | number | undefined> = {},
): URLSearchParams {
  const p = new URLSearchParams();
  const a = inputs.advanced;

  // ── Period window ──
  p.set("period_hours", String(inputs.periodHours));

  // ── Boolean filter short-circuit ──
  // When the active view was composed in Boolean mode, we ship the
  // Lucene string as `criteria_text` and SKIP the per-field arms
  // below. The backend resolver short-circuits to the compiled
  // Boolean WHERE — the per-field params would be ignored anyway,
  // so we save bytes on the wire.
  const booleanText = (inputs.criteriaText || "").trim();
  if (booleanText) {
    p.set("criteria_text", booleanText);
    // Tabs + toggles still apply on top of the Boolean filter.
    if (inputs.scope       !== "all") p.set("scope",        inputs.scope);
    if (inputs.quickFilter !== "all") p.set("quick_filter", inputs.quickFilter);
    if (inputs.includeClosed) p.set("include_closed_stories", "true");
    for (const [k, v] of Object.entries(extras)) {
      if (v === undefined || v === null || v === "") continue;
      p.set(k, String(v));
    }
    return p;
  }

  // ── Free-text + keyword filters ──
  if (a.query.trim())          p.set("q", a.query.trim());
  for (const kw of a.keywords)         if (kw) p.append("keywords", kw);
  for (const kw of a.excludedKeywords) if (kw) p.append("excluded_keywords", kw);

  // ── Topic + format ──
  for (const c of a.categories)            if (c) p.append("categories", c);
  for (const c of a.excludedCategories)    if (c) p.append("excluded_categories", c);
  for (const t of a.articleTypes)          if (t) p.append("article_types", t);
  for (const t of a.excludedArticleTypes)  if (t) p.append("excluded_article_types", t);

  // ── Language + feed + country (source side) ──
  for (const l of a.langs)     if (l) p.append("langs", l);
  for (const f of a.feeds)     if (f) p.append("feeds", f);
  for (const c of a.countries) if (c) p.append("source_countries", c);

  // ── Subject side ──
  for (const c of a.subjectCountries) if (c) p.append("subject_countries", c);

  // ── Entities ──
  // Entity filters carry entity_id (number).
  // `places` maps to the resolver's `locations` dimension for back-
  // compat naming on the Advanced struct (it predates kind=location).
  for (const v of a.persons)  if (v) p.append("persons",   String(v));
  for (const v of a.orgs)     if (v) p.append("orgs",      String(v));
  for (const v of a.places)   if (v) p.append("locations", String(v));
  for (const v of a.events)   if (v) p.append("events",    String(v));
  for (const v of a.markets)  if (v) p.append("markets",   String(v));
  for (const v of a.products) if (v) p.append("products",  String(v));

  // ── Tabs ──
  if (inputs.scope       !== "all") p.set("scope",        inputs.scope);
  if (inputs.quickFilter !== "all") p.set("quick_filter", inputs.quickFilter);

  // ── Toggles ──
  if (inputs.includeClosed) p.set("include_closed_stories", "true");

  // ── Extras (cursor / limit / item_type / window_hours) ──
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, String(v));
  }

  return p;
}


/**
 * Cheap hash of a WatchQueryInputs for use as a cache key / dependency.
 *
 * `JSON.stringify` on the serialized params produces a stable, content-
 * addressable string (params are added in a deterministic order in
 * `serializeWatchParams`). React deps arrays use referential equality,
 * so giving hooks this string avoids spurious refetches when callers
 * rebuild the WatchQueryInputs object without changing its content.
 */
export function watchQueryHash(inputs: WatchQueryInputs): string {
  // toString() concatenates the params in insertion order. Since
  // serializeWatchParams iterates the Advanced fields in a fixed order,
  // two inputs with identical content produce identical strings.
  return serializeWatchParams(inputs).toString();
}
