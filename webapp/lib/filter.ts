import type { Article, Singleton, Story } from "./types";
import type { Aggregations } from "./aggregate";
import { countryLabel, expandBroadToChildren, langLabel } from "./format";

/**
 * Watch scoping model — three orthogonal slots.
 *
 *   1. View (Tout / Non lus / Sauvegardés / Ignorées) — user_state-driven,
 *      lives in watch-main.tsx as `quickFilter`.
 *
 *   2. Scope — sidebar Explore single-select. Mutually exclusive with a
 *      non-"all" view: clicking a sidebar facet implicitly resets the view
 *      back to "all", and clicking a view (other than "all") implicitly
 *      clears the scope. There is at most ONE scope value at a time, by
 *      design (the sidebar is single-select exclusive).
 *
 *   3. Advanced filters — the dialog state, free to compose on top of any
 *      view and any scope. Multi-select, cumulable.
 *
 *   + a fourth, smaller slot: storyType — the list-panel tab
 *     (Tous / Communs / Originaux). Always-on, composes with everything.
 *
 * Each of these slots is a SEPARATE piece of state in watch-main. The old
 * monolithic `Filters` object that conflated all of them is gone.
 */

/* ─────────── Story type (list-panel tab) ─────────── */
export type StoryType = "all" | "communs" | "originaux";

/* ─────────── Scope (sidebar single-select) ─────────── */
/** Entity scopes carry an entity_id (number) of a canonical
 *  Wikidata-backed entity. Other scopes
 *  keep their string values (category names, ISO codes, etc.). */
export type Scope =
  | { kind: "none" }
  | { kind: "category"; value: string }
  | { kind: "lang"; value: string }
  | { kind: "feed"; value: string }
  | { kind: "country"; value: string }          // source country: article.source_country (ISO upper)
  | { kind: "subject_country"; value: string }  // article.countries (ISO upper), with region expansion
  | { kind: "person";  value: number }          // entities.id (BIGINT)
  | { kind: "org";     value: number }
  | { kind: "place";   value: number }          // entity kind=location
  | { kind: "event";   value: number }
  | { kind: "market";  value: number }
  | { kind: "product"; value: number };

export const emptyScope: Scope = { kind: "none" };

export function scopeIsActive(s: Scope): boolean {
  return s.kind !== "none";
}

/* ─────────── Advanced filters (dialog + search bar) ─────────── */
/**
 * The Advanced filter shape is reused TWO ways across the app:
 *
 *  1. **Ephemeral** — `WatchMain` holds an `advanced` state seeded from
 *     the user's persistent preferences at mount; the dialog mutates it
 *     for the current session.
 *
 *  2. **Persistent** — Saved views (`Story.criteria`) AND user
 *     preferences (`users.preferences` JSONB) store the same shape, so
 *     the runtime application is uniform.
 *
 * Two semantics coexist in the type:
 *  - **Inclusion** fields (categories, articleTypes, langs, feeds,
 *    countries, places, persons, orgs, keywords) — "keep articles that
 *    match any of these". Empty = no filter.
 *  - **Exclusion** fields (excludedCategories, excludedArticleTypes,
 *    excludedKeywords) — "hide articles that match any of these".
 *    Empty = no filter. Live alongside their inclusion siblings so a
 *    user can both "keep Tech & AI categories" AND "but exclude
 *    recap-type articles".
 *
 * For most users the persistent preferences will only set exclusion
 * fields + countries + periodMinutes — defining what they NEVER want
 * to see, leaving inclusion empty (= rest of the world stays visible).
 * Saved views typically use inclusion fields to define a curated lens.
 */
export interface Advanced {
  /** Free-text search bar in the list-panel header. Case-insensitive,
   *  matches against the article's title + summary + entities haystack. */
  query: string;
  /** 0 = no time limit; otherwise only articles within last N minutes. */
  periodMinutes: number;
  /** AND logic — all must be present in article haystack. */
  keywords: string[];
  /** OR logic — `article.category` includes any of these. */
  categories: string[];
  /** OR logic — `article.article_type` matches one of these. */
  articleTypes: string[];
  /** OR logic — `article.lang`. */
  langs: string[];
  /** OR logic — `article.feed_name`. */
  feeds: string[];
  /** OR logic — `article.source_country` ISO code (where the SOURCE publishes). */
  countries: string[];
  /** OR logic — `article.countries` ISO codes (countries the article is ABOUT,
   *  produced by the normalizer). Bilateral region expansion via
   *  `expandPlaceCodes`. Distinct from the noisier free-text `places` below;
   *  this is the structured, alert-grade subject-geo filter. */
  subjectCountries: string[];
  /** OR logic — canonical entity_ids (entities.id BIGINT). One of {persons, orgs, places, events, markets, products}
   *  holds the entity_ids for that kind. Backend AND-combines across
   *  kinds (persons AND orgs) and OR-combines within a kind.
   *  See backend watch_query.py QueryState. `places` here maps to
   *  entity kind `location`; the field name is kept so saved views
   *  stay readable. */
  places: number[];
  persons: number[];
  orgs: number[];
  events: number[];
  markets: number[];
  products: number[];
  /** Hide articles whose `category` contains any of these. */
  excludedCategories: string[];
  /** Hide articles whose `article_type` matches any of these. */
  excludedArticleTypes: string[];
  /** Hide articles whose haystack contains any of these (mute keywords). */
  excludedKeywords: string[];
}

export const emptyAdvanced: Advanced = {
  query: "",
  periodMinutes: 0,
  keywords: [],
  categories: [],
  articleTypes: [],
  langs: [],
  feeds: [],
  countries: [],
  subjectCountries: [],
  places: [],
  persons: [],
  orgs: [],
  events: [],
  markets: [],
  products: [],
  excludedCategories: [],
  excludedArticleTypes: [],
  excludedKeywords: [],
};

/**
 * Defensive merger for `Advanced` shapes coming from the DB.
 *
 * The Advanced type evolves over time (new fields like `articleTypes`
 * were added after some views were already saved). A saved view's
 * `criteria` JSONB may be missing newer fields entirely. Reading those
 * directly (e.g. `criteria.articleTypes.length`) crashes with "Cannot
 * read properties of undefined".
 *
 * Run every external Advanced through this helper before passing it
 * to render code. It keeps the user's set values intact and fills any
 * absent fields with their canonical empty defaults.
 */
export function normalizeAdvanced(input: Partial<Advanced> | null | undefined): Advanced {
  const merged: Advanced = { ...emptyAdvanced, ...(input ?? {}) };

  // Entity lists hold canonical entity_id numbers. Any saved view that
  // still carries surface-form strings has them silently dropped — the
  // list becomes empty rather than carrying invalid filters into the
  // resolver.
  const intArray = (v: unknown): number[] =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === "number" ? x : Number(x)))
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];
  merged.persons  = intArray(input?.persons);
  merged.orgs     = intArray(input?.orgs);
  merged.places   = intArray(input?.places);
  merged.events   = intArray(input?.events);
  merged.markets  = intArray(input?.markets);
  merged.products = intArray(input?.products);

  return merged;
}

// Defense-in-depth helpers — Advanced shapes can arrive from sessionStorage
// or server payloads written before a new field existed (`articleTypes` and
// `subjectCountries` are the two that bit us). Normalising at every boundary
// is the right fix, but the reader functions stay tolerant so a missed
// boundary surfaces as "filter looks off" instead of a runtime crash.
const _len = (arr: unknown): number => (Array.isArray(arr) ? arr.length : 0);

export function advancedIsActive(a: Advanced): boolean {
  return (
    (a.query ?? "").trim().length > 0 ||
    (a.periodMinutes ?? 0) > 0 ||
    _len(a.keywords) > 0 ||
    _len(a.categories) > 0 ||
    _len(a.articleTypes) > 0 ||
    _len(a.langs) > 0 ||
    _len(a.feeds) > 0 ||
    _len(a.countries) > 0 ||
    _len(a.subjectCountries) > 0 ||
    _len(a.places) > 0 ||
    _len(a.persons) > 0 ||
    _len(a.orgs) > 0 ||
    _len(a.events) > 0 ||
    _len(a.markets) > 0 ||
    _len(a.products) > 0 ||
    _len(a.excludedCategories) > 0 ||
    _len(a.excludedArticleTypes) > 0 ||
    _len(a.excludedKeywords) > 0
  );
}

/** How many dialog criteria are active (badge on the "Filtres" button).
 *  Note: excludes `query` — the search bar has its own visual indicator. */
export function countAdvanced(a: Advanced): number {
  return (
    ((a.periodMinutes ?? 0) > 0 ? 1 : 0) +
    _len(a.keywords) +
    _len(a.categories) +
    _len(a.articleTypes) +
    _len(a.langs) +
    _len(a.feeds) +
    _len(a.countries) +
    _len(a.subjectCountries) +
    _len(a.places) +
    _len(a.persons) +
    _len(a.orgs) +
    _len(a.events) +
    _len(a.markets) +
    _len(a.products) +
    _len(a.excludedCategories) +
    _len(a.excludedArticleTypes) +
    _len(a.excludedKeywords)
  );
}

/* ─────────── Matching ─────────── */

export function articleMatchesScope(a: Article, scope: Scope): boolean {
  switch (scope.kind) {
    case "none":
      return true;
    case "category":
      return (a.category ?? []).includes(scope.value);
    case "lang":
      return a.lang === scope.value;
    case "feed":
      return a.feed_name === scope.value;
    case "country":
      return (a.source_country ?? "").toUpperCase() === scope.value.toUpperCase();
    case "subject_country": {
      // Subject-countries sidebar click. Matches article.countries (ISO).
      // Broad codes (EU, AS, …) expand to their child countries, but a
      // leaf country never expands to its broad ancestor — clicking
      // "Malte" must NOT pull in the entire EU bucket.
      const expanded = expandBroadToChildren([scope.value]);
      const articleCountries = (a.countries ?? []).map((c) => c.toUpperCase());
      return articleCountries.some((c) => expanded.has(c));
    }
    // Entity scopes: match by entity_id from the flat LinkedEntity
    // list. The kind disambiguates which entity_id namespace we're
    // checking against (= safety net in case the same id appears
    // somehow in a different kind context).
    case "person":
      return (a.entities ?? []).some(
        (e) => e.kind === "person" && e.entity_id === scope.value,
      );
    case "org":
      return (a.entities ?? []).some(
        (e) => e.kind === "org" && e.entity_id === scope.value,
      );
    case "place":
      return (a.entities ?? []).some(
        (e) => e.kind === "location" && e.entity_id === scope.value,
      );
    case "event":
      return (a.entities ?? []).some(
        (e) => e.kind === "event" && e.entity_id === scope.value,
      );
    case "market":
      return (a.entities ?? []).some(
        (e) => e.kind === "market" && e.entity_id === scope.value,
      );
    case "product":
      return (a.entities ?? []).some(
        (e) => e.kind === "product" && e.entity_id === scope.value,
      );
  }
}

export function articleMatchesAdvanced(
  a: Article,
  adv: Advanced,
  storyTitle?: string,
): boolean {
  if (adv.categories.length > 0) {
    if (!(a.category ?? []).some((c) => adv.categories.includes(c))) return false;
  }
  if (adv.excludedCategories.length > 0) {
    if ((a.category ?? []).some((c) => adv.excludedCategories.includes(c))) {
      return false;
    }
  }
  if (adv.articleTypes.length > 0) {
    if (!a.article_type || !adv.articleTypes.includes(a.article_type)) {
      return false;
    }
  }
  if (adv.excludedArticleTypes.length > 0) {
    if (a.article_type && adv.excludedArticleTypes.includes(a.article_type)) {
      return false;
    }
  }
  if (adv.langs.length > 0) {
    if (!adv.langs.includes(a.lang)) return false;
  }
  if (adv.feeds.length > 0) {
    if (!a.feed_name) return false;
    if (!adv.feeds.includes(a.feed_name)) return false;
  }
  if (adv.countries.length > 0) {
    if (!a.source_country) return false;
    if (!adv.countries.includes(a.source_country.toUpperCase())) return false;
  }
  if (adv.subjectCountries.length > 0) {
    // Countries the article is ABOUT (article.countries from the normalizer).
    // One-way expansion only: broad → children (picking "EU" catches all EU
    // countries) but leaf countries don't expand to their broad (picking
    // "France" does NOT silently include every EU-tagged article — that's
    // the surprise bug we hit on small countries like Malta).
    const expanded = expandBroadToChildren(adv.subjectCountries);
    const articleCountries = (a.countries ?? []).map((c) => c.toUpperCase());
    if (!articleCountries.some((c) => expanded.has(c))) return false;
  }
  // Entity filters: numeric entity_id intersections per kind. Migration
  // 0054 — entities are now a flat list of LinkedEntity, grouped at
  // match time by their `kind` field.
  const entitiesOfKind = (kind: string): Set<number> =>
    new Set(
      (a.entities ?? [])
        .filter((e) => e?.kind === kind)
        .map((e) => e.entity_id),
    );
  if (adv.places.length > 0) {
    const ids = entitiesOfKind("location");
    if (!adv.places.some((id) => ids.has(id))) return false;
  }
  if (adv.persons.length > 0) {
    const ids = entitiesOfKind("person");
    if (!adv.persons.some((id) => ids.has(id))) return false;
  }
  if (adv.orgs.length > 0) {
    const ids = entitiesOfKind("org");
    if (!adv.orgs.some((id) => ids.has(id))) return false;
  }
  if (adv.events.length > 0) {
    const ids = entitiesOfKind("event");
    if (!adv.events.some((id) => ids.has(id))) return false;
  }
  if (adv.markets.length > 0) {
    const ids = entitiesOfKind("market");
    if (!adv.markets.some((id) => ids.has(id))) return false;
  }
  if (adv.products.length > 0) {
    const ids = entitiesOfKind("product");
    if (!adv.products.some((id) => ids.has(id))) return false;
  }
  if (adv.periodMinutes > 0) {
    if (!a.published_at) return false;
    const ageMin = (Date.now() - new Date(a.published_at).getTime()) / 60_000;
    if (ageMin < 0 || ageMin > adv.periodMinutes) return false;
  }
  const q = adv.query.trim().toLowerCase();
  const needsHaystack =
    adv.keywords.length > 0 ||
    adv.excludedKeywords.length > 0 ||
    q.length > 0;
  if (needsHaystack) {
    const haystack = [
      a.title,
      a.title_normalized,
      a.summary_normalized,
      a.summary,
      a.source,
      a.feed_name,
      ...(a.keywords ?? []),
      // Linked entity haystack — both canonical names and the raw
      // surface forms the article used, so a keyword search finds
      // both "Donald Trump" (canonical) and "Trump" (surface).
      ...(a.entities ?? []).flatMap((e) => [e.name, e.surface_form]),
      storyTitle ?? "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    for (const kw of adv.keywords) {
      if (!haystack.includes(kw.toLowerCase())) return false;
    }
    for (const muted of adv.excludedKeywords) {
      if (haystack.includes(muted.toLowerCase())) return false;
    }
    if (q && !haystack.includes(q)) return false;
  }
  return true;
}

/**
 * Deep filter: keep ONLY articles that match `advanced` (article-level
 * filter), drop stories that become empty afterward. Use this when you
 * need aggregations consistent with what a later `scope + advanced`
 * filter would yield.
 *
 * Why this exists: `applyFilters` is story-level (=
 * "keep story if SOME article matches"). The stories it returns still
 * carry every article, including ones that don't match advanced. If you
 * feed those to `aggregate(...)`, the sidebar gets entity counts that
 * include entities present on out-of-advanced articles — e.g. an editorial
 * mentioning Thomas Grjebine ends up contributing "Thomas Grjebine: 1"
 * to the sidebar even when the user's filter excludes opinion pieces.
 * Click → 0 results, sidebar lied.
 *
 * This helper narrows each story to only its matching articles, so
 * subsequent aggregation sees only what would survive a scope click.
 */
export function deepFilterByAdvanced(
  stories: Story[],
  singletons: Singleton[],
  advanced: Advanced,
): { stories: Story[]; singletons: Singleton[] } {
  advanced = normalizeAdvanced(advanced);
  if (!advancedIsActive(advanced)) {
    return { stories, singletons };
  }
  const filteredStories: Story[] = [];
  for (const s of stories) {
    const matchingArticles = s.articles.filter((a) =>
      articleMatchesAdvanced(a, advanced, s.title),
    );
    if (matchingArticles.length > 0) {
      filteredStories.push({ ...s, articles: matchingArticles });
    }
  }
  const filteredSingletons = singletons.filter((a) =>
    articleMatchesAdvanced(a, advanced),
  );
  return { stories: filteredStories, singletons: filteredSingletons };
}


/**
 * Apply scope + advanced filters to stories+singletons. Returns the
 * filtered lists. View (quickFilter) and storyType are applied separately
 * (view depends on per-user state, storyType only on cluster shape).
 */
export function applyFilters(
  stories: Story[],
  singletons: Singleton[],
  scope: Scope,
  advanced: Advanced,
): { stories: Story[]; singletons: Singleton[] } {
  // Guarantee fully-formed shape for the matchers below (they access
  // fields directly with `.length`). Cheap shallow merge — protects
  // against the same class of bug that hit `subjectCountries` /
  // `articleTypes` when shapes were loaded raw from storage.
  advanced = normalizeAdvanced(advanced);

  const noScope = scope.kind === "none";
  const noAdv = !advancedIsActive(advanced);
  if (noScope && noAdv) {
    return { stories, singletons };
  }

  // Story-level qualifier: at least one article in the cluster must
  // match the scope/advanced filter.
  const filteredStories = stories.filter((s) =>
    s.articles.some(
      (a) =>
        articleMatchesScope(a, scope) &&
        articleMatchesAdvanced(a, advanced, s.title),
    ),
  );
  const filteredSingletons = singletons.filter(
    (a) =>
      articleMatchesScope(a, scope) && articleMatchesAdvanced(a, advanced),
  );

  return { stories: filteredStories, singletons: filteredSingletons };
}

/* ─────────── Describing the active scope (list-panel header) ─────────── */

export interface ActiveScopeLabel {
  /** Short user-facing kind, e.g. "Feed", "Personne", "Origine". */
  kind: string;
  /** Human-readable value, e.g. "Reuters - World", "Donald Trump", "France". */
  value: string;
}

const KIND_LABELS: Record<string, Record<Scope["kind"], string>> = {
  en: {
    none: "",
    feed: "Feed",
    category: "Category",
    lang: "Language",
    country: "Origin",
    subject_country: "Country covered",
    person: "Person",
    org: "Organization",
    place: "Place",
    event: "Event",
    market: "Market",
    product: "Product",
  },
  fr: {
    none: "",
    feed: "Feed",
    category: "Catégorie",
    lang: "Langue",
    country: "Origine",
    subject_country: "Pays concerné",
    person: "Personne",
    org: "Organisation",
    place: "Lieu",
    event: "Évènement",
    market: "Marché",
    product: "Produit",
  },
};

function kindFor(key: Scope["kind"], locale: string): string {
  const lang = (locale ?? "").toLowerCase().split("-")[0] === "fr" ? "fr" : "en";
  return KIND_LABELS[lang][key] ?? KIND_LABELS.en[key];
}

export function describeScope(
  scope: Scope,
  aggs: Aggregations,
  locale: string,
): ActiveScopeLabel | null {
  if (scope.kind === "none") return null;
  // Resolve an entity_id to its canonical display name via the
  // aggregations (the sidebar already has them loaded). Falls back to
  // "#<id>" if the entity isn't in the current aggregations slice,
  // which only happens for picks held in state but no longer in the
  // user's universe — rare edge case worth surfacing as the id.
  const entityName = (
    bucket: { entity_id: number; name: string }[],
    eid: number,
  ): string => bucket.find((e) => e.entity_id === eid)?.name ?? `#${eid}`;
  switch (scope.kind) {
    case "feed":
      return { kind: kindFor("feed", locale), value: scope.value };
    case "category":
      return { kind: kindFor("category", locale), value: scope.value };
    case "lang":
      return { kind: kindFor("lang", locale), value: langLabel(scope.value, locale) };
    case "country":
      return { kind: kindFor("country", locale), value: countryLabel(scope.value, locale) };
    case "subject_country":
      return { kind: kindFor("subject_country", locale), value: countryLabel(scope.value, locale) };
    case "person":
      return { kind: kindFor("person", locale), value: entityName(aggs.entities.persons, scope.value) };
    case "org":
      return { kind: kindFor("org", locale), value: entityName(aggs.entities.orgs, scope.value) };
    case "place":
      return { kind: kindFor("place", locale), value: entityName(aggs.entities.locations, scope.value) };
    case "event":
      return { kind: kindFor("event", locale), value: entityName(aggs.entities.events, scope.value) };
    case "market":
      return { kind: kindFor("market", locale), value: entityName(aggs.entities.markets, scope.value) };
    case "product":
      return { kind: kindFor("product", locale), value: entityName(aggs.entities.products, scope.value) };
  }
}
