import type { Aggregations } from "@/lib/aggregate";

/**
 * Fixtures shared by component tests.
 *
 * Kept deliberately empty by default and widened per test with a spread.
 * A fat default fixture makes every test depend on data it does not care
 * about, and the day one field changes shape, tests fail in places that
 * have nothing to do with it.
 */
export function emptyAggs(over: Partial<Aggregations> = {}): Aggregations {
  return {
    feeds: [],
    feedsByRegion: {},
    regions: [],
    originByRegion: [],
    subjectCountriesByRegion: [],
    categories: [],
    langs: [],
    lieux: [],
    entities: {
      persons: [],
      orgs: [],
      locations: [],
      events: [],
      markets: [],
      products: [],
    },
    total: { stories: 0, singletons: 0, articles: 0, feeds: 0 },
    ...over,
  };
}

import type { View, WatchData } from "@/lib/types";

/** A minimal but valid /watch payload: an owner, no content. */
export function emptyWatchData(over: Partial<WatchData> = {}): WatchData {
  return {
    user: "Test User",
    slug: "test-user",
    window_hours: 24,
    stats: {
      n_articles: 0,
      n_stories: 0,
      n_singletons: 0,
      n_relabeled: 0,
      n_translated: 0,
      n_cached: 0,
      relabel_cost: 0,
      translate_cost: 0,
    },
    stories: [],
    singletons: [],
    viewer: { is_authenticated: true, is_owner: true },
    read_article_ids: [],
    views: [],
    folders: [],
    next_cursor: null,
    is_initial_page: true,
    ...over,
  };
}

/** A saved view, named so assertions can look for the name on screen. */
export function view(name: string, over: Partial<View> = {}): View {
  return {
    id: `view-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    criteria: {},
    ...over,
  } as View;
}

import type {
  AdminAuditRow,
  AdminFeed,
  AdminSource,
  AdminUser,
} from "@/lib/admin/api";

export function adminUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "user-1",
    slug: "camille",
    name: "Camille Roy",
    email: "camille@example.com",
    output_lang: "fr",
    active: true,
    is_public: false,
    plan: "demo",
    ...over,
  };
}

export function adminSource(over: Partial<AdminSource> = {}): AdminSource {
  return {
    id: 1,
    name: "Le Monde",
    domain: "lemonde.fr",
    country: "FR",
    paywall_policy: null,
    robots_skip: false,
    added_at: null,
    n_feeds_alive: 2,
    n_feeds_dead: 0,
    ...over,
  };
}

export function adminFeed(over: Partial<AdminFeed> = {}): AdminFeed {
  return {
    id: 10,
    slug: "lemonde-une",
    name: "Le Monde — À la une",
    url: "https://lemonde.fr/rss/une.xml",
    feed_type: "rss",
    country: "fr",
    source_id: 1,
    source_name: "Le Monde",
    source_domain: "lemonde.fr",
    source_country: "FR",
    status: "active",
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
    added_at: null,
    starter: false,
    ...over,
  };
}

export function adminAuditRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: 1,
    actor_user_id: "user-1",
    actor_slug: "camille",
    actor_name: "Camille Roy",
    actor_email: "camille@example.com",
    action: "feed.create",
    target_type: "feed",
    target_id: "10",
    payload: {},
    created_at: null,
    ...over,
  };
}
