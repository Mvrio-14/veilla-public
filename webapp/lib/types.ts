/**
 * Types matching the Veilla backend API response shape.
 * Source: GET /users/{slug}/watch
 */

export type Lang = "fr" | "en" | "de" | "es" | "it" | "pt" | "zh" | "ar" | string;

/** One canonical entity as resolved against Wikidata by the backend's
 *  entity resolver. Articles carry a flat list of these; consumers group
 *  by `kind` at render time. */
export interface LinkedEntity {
  /** Stable canonical id from `entities` table (BIGINT). Use this as
   *  the React key + the filter value for `Advanced.persons` /
   *  `.orgs` / etc. */
  entity_id: number;
  /** Wikidata Q-id, e.g. "Q22686". NULL when the resolver couldn't
   *  link the mention to a Wikidata entity (= source='unlinked'). */
  qid: string | null;
  /** Canonical English display label. */
  name: string;
  kind: "person" | "org" | "location" | "event" | "market" | "product";
  /** ISO 3166-1 alpha-2 code (or null). For persons this comes from
   *  Wikidata P27 (citizenship); for everything else from P17. */
  country: string | null;
  /** Commons Special:FilePath URL — portrait for persons, logo for
   *  orgs. NULL when Wikidata has no P18 image for this entity. */
  image_url: string | null;
  /** Wikidata short description, e.g. "President of France since 2017". */
  description: string | null;
  /** Per-mention importance score 1-5 (entity_resolver). Higher = the
   *  entity the article is mostly about. NULL if the resolver didn't
   *  emit a salience (= legacy rows). */
  salience: number | null;
  /** The exact substring the extractor pulled from the article ("Trump"
   *  even when the linked entity is "Donald Trump"). For debugging /
   *  highlighting in UI. */
  surface_form: string;
}

/** Per-(user, story) action state. Present only when the viewer is the
 *  watch's owner — for non-owners or anonymous visitors this is `null`,
 *  which the UI uses to render action buttons as disabled placeholders. */
export interface UserState {
  saved: boolean;
  ignored: boolean;
  /** Owner-only opt-in subscription to per-story notifications.
   *  When true, the bell glyph on the story renders
   *  active; toggling it hits POST/DELETE /stories/{id}/follow. */
  followed: boolean;
  is_unread: boolean;
  has_update: boolean;
  /** ISO timestamp the viewer last opened this story, or null if never. */
  read_at: string | null;
  /** IDs of manual folders this story is currently in. Empty array when
   *  not in any folder. Drives the FolderPickerDialog's initial
   *  checked-state. Save and Folder are independent, so a
   *  story can be in folders without being saved (and vice versa). */
  folder_ids: string[];
}

export interface ArticleFeed {
  id: number;
  name: string;
  country: string | null;
  url: string;
  source: string | null;
}

export interface Article {
  id: number;
  source: string;
  feed_name: string;
  title: string;
  title_normalized: string;
  title_translations: Record<string, string>;
  url: string;
  summary: string;
  summary_normalized: string;
  summary_translations?: Record<string, string>;
  image_url: string | null;
  lang: Lang;
  category: string[];
  countries: string[];
  source_country: string | null;
  published_at: string; // ISO
  fetched_at: string;   // ISO
  keywords: string[];
  /** Flat list of canonical entities. Already sorted by salience DESC,
   *  so consumers can take the top-N to render chips without re-sort. */
  entities: LinkedEntity[];
  source_url: string | null;
  feed_url: string | null;
  article_type: string;
  story_id: number;
  /** All feeds that delivered this canonical article. One entry per feed,
   *  even when the article was syndicated across multiple Bloomberg / NYT /
   *  etc. RSS endpoints. The detail panel renders this list verbatim. */
  feeds?: ArticleFeed[];
  /** Singletons that are tied to a story carry user state too. */
  user_state?: UserState | null;
  /** True iff the displayed `title` is a cached translation (not the
   *  source-language original). Drives the source-lang chip on rows. */
  title_is_translated?: boolean;
  /** Same logic for `summary_normalized` — used in the detail panel. */
  summary_is_translated?: boolean;
  /** Raw RSS byline from `<author>` / `<dc:creator>`. Single string.
   *  Often null on feeds that only use `<author><name>X</name></author>`
   *  Atom shape (= populated in `authors` instead). Surfaced raw so the
   *  UI can spot fake bylines (= publisher names, "Service Actu",
   *  wire agencies, weird formats like "DIE ZEIT: Ausland - Caspar Leder"). */
  author?: string | null;
  /** Atom `<author><name>X</name></author>` repeated entries. feedparser
   *  produces `[{name, email?, href?}]`. Used together with `author`
   *  via the `articleByline()` helper which dedupes and falls back. */
  authors?: ArticleAuthor[] | null;
}

/** feedparser's normalized shape for `<author>` (Atom) entries. */
export interface ArticleAuthor {
  name?: string;
  email?: string | null;
  href?: string | null;
}

export interface StoryUpdate {
  /** Single fact bullet, already in the API's output language. */
  content: string;
  /** ISO timestamp marking when the fact was detected (= when the source
   *  article was processed by update_processor). The UI uses this for
   *  the timeline ordering and the displayed time. */
  added_at: string;
}

export interface Story {
  title: string;            // already translated to user's display lang
  /** Origin paragraph — the immutable anchor at the top of the story's
   *  detail panel, generated once from the seed article. Already
   *  translated to the user's display lang via stories.origin_translations.
   *  Null when update_processor hasn't run yet for this story. */
  origin: string | null;
  /** Per-user synthesis paragraph (already translated to display lang or
   *  regenerated from the user's article subset, depending on overlap).
   *  Null when no synthesis has been computed yet for this story×user. */
  synthesis: string | null;
  /** Timeline of fact bullets surfaced for this story. Already filtered
   *  to articles visible to the user. Sorted by added_at DESC. Empty
   *  array when no updates yet. */
  updates: StoryUpdate[];
  sources: string[];
  n_sources: number;
  image_url: string | null;
  articles: Article[];
  categories: string[];
  type: "cluster";
  user_state?: UserState | null;
  /** Present only on /library — the time the user bookmarked this story. */
  saved_at?: string;
  /** Present only on /library/{id} — the time the story was filed into
   *  the current folder. Drives the granularity grouping (Day / Week /
   *  Month / Year / All) the same way `saved_at` drives it in Library. */
  added_at?: string;
  /** Present only on /library — the underlying story id (cluster-level). */
  story_id?: number;
  /** Present only on /library — drives the unsave-confirm popup. A closed
   *  story removed from the library is purged by the cleanup; an active
   *  one can be re-saved at any time from Watch. */
  status?: "active" | "closed";
}

// Singletons are returned as flat Article objects (they ARE the article).
export type Singleton = Article;

export interface WatchStats {
  n_articles: number;
  n_stories: number;
  n_singletons: number;
  n_relabeled: number;
  n_translated: number;
  n_cached: number;
  relabel_cost: number;
  translate_cost: number;
}

export interface Viewer {
  is_authenticated: boolean;
  is_owner: boolean;
}

/**
 * Saved view (UI label "Mes vues") — a named set of advanced filter
 * criteria saved per-user. Stories aren't stored on the view; the
 * frontend derives view contents at render time by applying `criteria`
 * to the watch payload it already has in memory.
 *
 * `criteria` mirrors `Advanced` from lib/filter.ts. We import it via
 * type-only import to keep the runtime graph acyclic (types.ts is the
 * base layer that filter.ts imports from — type-only imports are erased
 * at compile time and don't trigger module cycles).
 */
export interface View {
  id: string;
  name: string;
  criteria: import("./filter").Advanced;
  /** Lucene-syntax Boolean query string. When set, takes precedence
   *  over `criteria`. NULL on views composed in Panel mode. */
  criteria_text: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Manual folder — a per-user named collection of stories. Stories are
 * added EXPLICITLY by the user via the FolderPickerDialog (vs `View`,
 * where membership is derived from `criteria` at render time).
 *
 * `story_count` is a server-computed convenience for the sidebar badge
 * — the actual membership lives in the per-story `UserState.folder_ids`
 * on each watch story.
 */
export interface Folder {
  id: string;
  name: string;
  story_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Full universe of filterable values for the current user — independent of
 * the articles currently surfacing in the watch.
 *
 * Used in the ViewEditDialog (saved-view definition) so the user can
 * pick languages / countries / categories / feeds that may not have any
 * article today but could match incoming ones tomorrow. The FiltersDialog
 * (ad-hoc) keeps using `aggs` instead, because filtering by absent values
 * there is just pointless (0 results).
 *
 * Owner-only — undefined for anon / non-owner viewers.
 */
export interface WatchUniverse {
  /** Canonical category strings from the normalizer. */
  categories: string[];
  /** Supported ISO lang codes (display labels resolved client-side). */
  langs: string[];
  /** The user's complete feed subscription list. */
  feeds: { id: number; name: string; country: string | null; url: string }[];
  /** Distinct source-country codes derived from the user's feeds. */
  countries: { code: string }[];
}

export interface WatchData {
  user: string;
  slug: string;
  window_hours: number;
  stats: WatchStats;
  stories: Story[];
  singletons: Singleton[];
  viewer: Viewer;
  /** Owner-only. Article IDs the user has already read (clicked, or
   *  closed the parent cluster). Hydrates the SPA's `consumedArticles`
   *  Set so the dots persist across refreshes. */
  read_article_ids?: number[];
  /** Owner-only. Saved views defined by the user. Empty for anon
   *  viewers / non-owners. */
  views?: View[];
  /** Owner-only. Manual folders defined by the user. Each story's
   *  `user_state.folder_ids` points into this list. */
  folders?: Folder[];
  /** Owner-only. Full universe of filterable values for view definition. */
  universe?: WatchUniverse;
  /** Owner-only. Persistent default `Advanced`-shaped filter
   *  preferences. The SPA seeds its `advanced` state from this on
   *  /watch mount so the user's editorial defaults apply automatically.
   *  Type-only `import` of `Advanced` to keep the runtime module
   *  graph acyclic (types.ts is the base layer that filter.ts depends
   *  on, not the other way). */
  preferences?: import("./filter").Advanced;
  /** Sidebar aggregations precomputed server-side. Always
   *  present on initial-page responses; null on subsequent pages
   *  (the SPA keeps the first-page payload).
   *  Flat-shape payload; the adapter in `lib/server-aggs.ts` converts
   *  it into the `Aggregations` shape consumed by the Sidebar /
   *  ListPanel / ViewEditDialog. */
  aggs_server?: ServerAggs | null;
  /** Filter-aware aggregations matching the
   *  /watch/aggregations endpoint payload, embedded inline so the SPA
   *  can paint correct counters on the first render without a separate
   *  round-trip. Null on non-initial pages and for anon viewers.
   *  Computed for the SAME QueryState as the /watch request — clients
   *  consume it via the `useWatchAggs` hook's `initialData` option. */
  watch_aggs?: import("./actions").WatchAggregations | null;
  /** Pagination cursor — opaque token for `/users/{slug}/watch?cursor=...`.
   *  null when this page exhausts the recency-sorted stream. */
  next_cursor?: string | null;
  /** True when this response is the first page of a /watch session
   *  (= the SPA replaces its state). False on subsequent pages (=
   *  append stories+singletons to the accumulator). The SPA decides
   *  whether to keep the just-received views/folders/etc. based on
   *  this flag. */
  is_initial_page?: boolean;
}

/** Flat server-computed sidebar aggregations. Each row carries both
 *  total count and unread count per dimension value. The frontend
 *  adapter localizes country/region/lang labels at render time. */
export interface ServerAggs {
  feeds: {
    name: string;
    source: string | null;
    country: string | null;
    count: number;
    unread: number;
  }[];
  langs: { code: string; count: number; unread: number }[];
  origin_countries: { code: string; count: number; unread: number }[];
  subject_countries: { code: string; count: number; unread: number }[];
  categories: { name: string; count: number; unread: number }[];
  entities: {
    persons:   ServerEntityAgg[];
    orgs:      ServerEntityAgg[];
    locations: ServerEntityAgg[];
    events:    ServerEntityAgg[];
    markets:   ServerEntityAgg[];
    products:  ServerEntityAgg[];
  };
  total: {
    stories:    number;
    singletons: number;
    articles:   number;
    feeds:      number;
  };
}

export interface ServerEntityAgg {
  /** Stable canonical id from `entities` table (BIGINT). Primary key
   *  for filter selection + dedup across the response. */
  entity_id: number;
  /** Wikidata Q-id, e.g. "Q22686". NULL when unlinked. */
  qid: string | null;
  /** Canonical English display label. */
  name: string;
  kind: "person" | "org" | "location" | "event" | "market" | "product";
  /** ISO 3166-1 alpha-2 (or null). */
  country: string | null;
  image_url: string | null;
  description: string | null;
  count: number;
  unread: number;
}

/**
 * Payload returned by GET /me/folders/{folder_id}. Backs the standalone
 * Dossiers mode. Carries the full content of one folder, plus the
 * user's complete folder list so the contextual sidebar can render every
 * folder without an extra round-trip.
 */
export interface FolderData {
  folder: {
    id: string;
    name: string;
    created_at: string | null;
    updated_at: string | null;
  };
  /** Stories filed into this folder. */
  stories: Story[];
  /** Always empty — folders only hold full stories. */
  singletons: Singleton[];
  stats: {
    n_stories: number;
    n_singletons: number;
    n_articles: number;
  };
  /** Every folder of the user. Drives the folders-sidebar nav. */
  folders: Folder[];
}

export interface SavedData {
  stories: Story[];   // each carries saved_at + story_id
  total: number;
  /** User's saved views — same as WatchData.views. Drives the
   *  Library view selector. */
  views?: View[];
  /** Manual folders — same as WatchData.folders. Drives the Library
   *  folder selector (separate dropdown from the view picker). */
  folders?: Folder[];
  /** Full universe of filterable values, drives the view definition
   *  values in the FilterPicker. Mirrors WatchData.universe. */
  universe?: WatchUniverse;
}
