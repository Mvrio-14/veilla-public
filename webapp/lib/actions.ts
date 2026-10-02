"use client";

import { createClient } from "@/lib/supabase/client";
import type { Advanced } from "@/lib/filter";
import type { ReadingContext, Watcher } from "@/lib/signal";
import type { Folder, View, WatchData } from "@/lib/types";
import {
  serializeWatchParams,
  type WatchQueryInputs,
} from "@/lib/watch-query";

export type Preferences = Advanced;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Client-side action helpers — wrap the auth dance (grab the JWT from the
 * Supabase session, attach it as a Bearer header) so call sites stay
 * one-liners: `await saveStory(123)`.
 *
 * All of these are best-effort, fire-and-forget from the UI's perspective
 * (we use optimistic updates). The promise is exposed for callers that
 * want to wait or roll back on failure.
 */

async function authedFetch(path: string, init: RequestInit): Promise<Response> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("Not authenticated");
  }
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
    },
  });
}

export async function saveStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/save`, { method: "POST" });
  if (!res.ok) throw res;
}

export async function unsaveStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/save`, { method: "DELETE" });
  if (!res.ok) throw res;
}

export async function ignoreStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/ignore`, { method: "POST" });
  if (!res.ok) throw res;
}

export async function unignoreStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/ignore`, {
    method: "DELETE",
  });
  if (!res.ok) throw res;
}

/**
 * Subscribe to per-story notifications. Idempotent.
 * Server fires a `story_update` notif when:
 *   - a new article attaches to this story (clusterer hook), or
 *   - a new story_update lands (update_processor hook).
 * Per-channel delivery is gated by the user's notif_prefs.
 */
export async function followStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/follow`, { method: "POST" });
  if (!res.ok) throw res;
}

export async function unfollowStory(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/follow`, {
    method: "DELETE",
  });
  if (!res.ok) throw res;
}

/* ─────────── Notifications ─────────── */

/** Dismiss a single inbox notification — removes it for good (Gmail / Slack
 *  pattern: handling = clearing). Fired on row click + on the per-row X.
 *  Idempotent server-side; deleting an already-gone row is a no-op. */
export async function clearNotification(notifId: number): Promise<void> {
  const res = await authedFetch(`/me/notifications/${notifId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw res;
}

/** Clear the caller's whole inbox in one trip. Powers the "Tout effacer"
 *  button in the bell popover. Destructive — the SPA gates it behind a
 *  confirm step. */
export async function clearAllNotifications(): Promise<{ deleted: number }> {
  const res = await authedFetch(`/me/notifications`, {
    method: "DELETE",
  });
  if (!res.ok) throw res;
  return res.json();
}

/** Replace the caller's full notification channel preferences.
 *  Server normalizes — missing keys fall back to defaults. */
export async function updateNotifPrefs(
  prefs: import("./api").NotifPrefs,
): Promise<import("./api").NotifPrefs> {
  const res = await authedFetch(`/me/notif-prefs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function markStoryRead(storyId: number): Promise<void> {
  const res = await authedFetch(`/stories/${storyId}/read`, { method: "POST" });
  if (!res.ok) throw res;
}

/** Bulk-mark stories as read ("Tout marquer comme lu" in the Watch header).
 *  Pass every story id currently loaded in the watch — the server marks
 *  exactly those, regardless of the active filter. Returns how many rows
 *  it marked. */
export async function markAllStoriesRead(
  storyIds: number[],
): Promise<{ marked: number }> {
  const res = await authedFetch(`/me/stories/read-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ story_ids: storyIds }),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function markArticleRead(articleId: number): Promise<void> {
  const res = await authedFetch(`/articles/${articleId}/read`, { method: "POST" });
  if (!res.ok) throw res;
}

/**
 * Replace the caller's persistent preferences. The full shape is
 * written each call — the Settings form always submits the complete
 * state, so no PATCH semantics needed. Returns the server-normalized
 * shape (= what's actually stored, after dedup / type coercion).
 */
export async function updatePreferences(
  prefs: Preferences,
): Promise<Preferences> {
  const res = await authedFetch(`/me/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(prefs),
  });
  if (!res.ok) throw res;
  return res.json();
}

/* ─────────── Saved views (Mes vues) ───────────
 *
 * CRUD on the per-user `views` table. The read path is bundled in the
 * /watch payload (WatchData.views) so there's no `listViews` here —
 * the parent component triggers a refetch after each mutation to pick up
 * the new state.
 */

export async function createView(
  name: string,
  criteria: Advanced,
  criteriaText: string | null = null,
): Promise<View> {
  const res = await authedFetch("/me/views", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      criteria,
      // Lucene Boolean string. When non-null the backend stores it on
      // views.criteria_text — the resolver prefers it over the
      // `criteria` JSONB at read time.
      criteria_text: criteriaText,
    }),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function updateView(
  viewId: string,
  name: string,
  criteria: Advanced,
  criteriaText: string | null = null,
): Promise<View> {
  const res = await authedFetch(`/me/views/${viewId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name, criteria, criteria_text: criteriaText,
    }),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function deleteView(viewId: string): Promise<void> {
  const res = await authedFetch(`/me/views/${viewId}`, { method: "DELETE" });
  if (!res.ok) throw res;
}

/* ─────────── Manual folders ───────────
 *
 * CRUD on the per-user `folders` table + add/remove story membership on
 * the `folder_stories` junction. Adding a story auto-saves it on the
 * backend (Folder ⊃ Save), so callers don't need to also call saveStory.
 *
 * The read path is bundled in /watch (WatchData.folders) and /me/saved
 * (SavedData.folders) — no `listFolders` here; parent components refetch
 * or maintain client-side state after mutations.
 */

export async function createFolder(name: string): Promise<Folder> {
  const res = await authedFetch("/me/folders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function renameFolder(
  folderId: string,
  name: string,
): Promise<Folder> {
  const res = await authedFetch(`/me/folders/${folderId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw res;
  return res.json();
}

export async function deleteFolder(folderId: string): Promise<void> {
  const res = await authedFetch(`/me/folders/${folderId}`, { method: "DELETE" });
  if (!res.ok) throw res;
}

export async function addStoryToFolder(
  folderId: string,
  storyId: number,
): Promise<void> {
  const res = await authedFetch(
    `/me/folders/${folderId}/stories/${storyId}`,
    { method: "POST" },
  );
  if (!res.ok) throw res;
}

export async function removeStoryFromFolder(
  folderId: string,
  storyId: number,
): Promise<void> {
  const res = await authedFetch(
    `/me/folders/${folderId}/stories/${storyId}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw res;
}


/**
 * Fetch a page of /watch with the full server-side filter set — search
 * bar, sidebar entity picks, scope tabs and quick filters all narrow the
 * result on the server. Used by the SPA to load pages after the
 * SSR-rendered first one, and to refetch from the start after a filter
 * or tab change.
 *
 * Accepts an `AbortSignal` so callers can cancel in-flight requests
 * when the user types into the search box or flips a tab faster than
 * the network roundtrip. `useWatchPage` in `lib/use-watch.ts` wires this
 * end-to-end.
 *
 * @param slug      target user (typically `viewer.slug` for the SPA owner)
 * @param inputs    the active QueryState equivalent (advanced, scope,
 *                  quickFilter, periodHours, includeClosed)
 * @param cursor    null for first page; pass `next_cursor` from the
 *                  previous response for subsequent pages
 * @param limit     page size; omit to use the server default (50)
 * @param itemType  paginator stream-id ("communs" / "originaux" / "all").
 *                  A tab change changes the stream identity, so the
 *                  caller must reset its accumulated pages.
 * @param signal    AbortSignal from a hook's AbortController
 */
export async function fetchWatchFiltered(
  slug: string,
  inputs: WatchQueryInputs,
  opts: {
    cursor?:   string | null;
    limit?:    number;
    itemType?: "all" | "communs" | "originaux";
    signal?:   AbortSignal;
  } = {},
): Promise<WatchData> {
  const params = serializeWatchParams(inputs, {
    cursor:    opts.cursor ?? undefined,
    limit:     opts.limit,
    item_type: opts.itemType && opts.itemType !== "all" ? opts.itemType : undefined,
  });
  const path = `/users/${encodeURIComponent(slug)}/watch?${params.toString()}`;
  const res = await authedFetch(path, { method: "GET", signal: opts.signal });
  if (!res.ok) throw res;
  return res.json() as Promise<WatchData>;
}


/**
 * Response shape of /users/{slug}/watch/aggregations. The sidebar reads this verbatim — no client-side
 * computation. Drill-down semantics (per facet) live in the backend;
 * the SPA just renders.
 */
export interface ServerEntityFacetRow {
  entity_id: number;
  qid: string | null;
  name: string;
  kind: "person" | "org" | "location" | "event" | "market" | "product";
  country: string | null;
  image_url: string | null;
  description: string | null;
  count: number;
}

export interface WatchAggregations {
  total_count: number;
  by_scope:        { all: number; common: number; original: number };
  by_quick_filter: { all: number; unread: number; saved: number; ignored: number };
  /** Multi-value facets: `{value, count}` lists capped at TOP_N (50).
   *  Sibling `*_has_more` boolean signals truncation. */
  /** Entity facets return canonical rows — the backend joins article_entities + entities and exposes the full
   *  metadata bag so the sidebar can render avatars / flags / desc
   *  without a follow-up DB lookup. */
  by_entity_persons:   ServerEntityFacetRow[];
  by_entity_orgs:      ServerEntityFacetRow[];
  by_entity_locations: ServerEntityFacetRow[];
  by_entity_events:    ServerEntityFacetRow[];
  by_entity_markets:   ServerEntityFacetRow[];
  by_entity_products:  ServerEntityFacetRow[];
  by_categories:        { value: string; count: number }[];
  by_subject_countries: { value: string; count: number }[];
  by_source_countries:  { value: string; count: number }[];
  by_feeds:             { value: string; count: number }[];
  by_langs:             { value: string; count: number }[];
  by_article_types:     { value: string; count: number }[];
  by_entity_persons_has_more:   boolean;
  by_entity_orgs_has_more:      boolean;
  by_entity_locations_has_more: boolean;
  by_entity_events_has_more:    boolean;
  by_entity_markets_has_more:   boolean;
  by_entity_products_has_more:  boolean;
  by_categories_has_more:        boolean;
  by_subject_countries_has_more: boolean;
  by_source_countries_has_more:  boolean;
  by_feeds_has_more:             boolean;
  by_langs_has_more:             boolean;
  by_article_types_has_more:     boolean;
}


/**
 * Fetch the sidebar aggregations for the current filter set.
 * Cancel-able via `signal`. The SPA debounces filter changes to ~250ms
 * before calling this, so we never hammer it on raw keystrokes.
 */
export async function fetchWatchAggs(
  slug: string,
  inputs: WatchQueryInputs,
  signal?: AbortSignal,
): Promise<WatchAggregations> {
  const params = serializeWatchParams(inputs);
  const path =
    `/users/${encodeURIComponent(slug)}/watch/aggregations?${params.toString()}`;
  const res = await authedFetch(path, { method: "GET", signal });
  if (!res.ok) throw res;
  return res.json() as Promise<WatchAggregations>;
}


/**
 * Per-view item counts.
 * Returns `{ counts: { viewId: int } }` for each of the user's saved
 * views — the sidebar's "Mes vues" section consumes this to render a
 * badge next to each view name.
 *
 * Server-side this is heavy (~30s cold on big users) — the frontend
 * hook (`useViewCounts`) fires this AFTER /watch returns so it never
 * blocks the initial paint. Process-local cache (60s TTL) makes
 * repeated calls instant. View CRUD invalidates the cache server-side
 * automatically.
 */
export interface ViewCountsPayload {
  counts: Record<string, number>;
  /** Echoed by the server so the client can confirm which window the
   *  displayed counts reflect (useful for stale-cache detection). */
  period_hours?: number;
}

export async function fetchViewCounts(
  periodHours?: number,
  signal?: AbortSignal,
): Promise<ViewCountsPayload> {
  const qs = periodHours ? `?period_hours=${periodHours}` : "";
  const res = await authedFetch(`/me/views/counts${qs}`, { method: "GET", signal });
  if (!res.ok) throw res;
  return res.json() as Promise<ViewCountsPayload>;
}

/* ─────────── Signal ─────────── */

async function sendJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await authedFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw res;
  return res.json();
}

export const saveContext = (body: string) =>
  sendJson<ReadingContext>("/me/signal/context", "PUT", { body });

export const createWatcher = (watcher: { name: string; request: string; monitor_ids: number[] }) =>
  sendJson<Watcher>("/me/signal/watchers", "POST", watcher);

/** Changes only what is given. `monitor_ids: []` means every monitor. */
export const updateWatcher = (
  id: number,
  patch: Partial<Pick<Watcher, "name" | "request" | "status" | "monitor_ids">>,
) => sendJson<Watcher>(`/me/signal/watchers/${id}`, "PATCH", patch);

export const deleteWatcher = (id: number) =>
  sendJson<{ ok: boolean }>(`/me/signal/watchers/${id}`, "DELETE");
