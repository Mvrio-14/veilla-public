import type { Advanced } from "./filter";
import type { Monitor, MonitorItem, MonitorRun } from "./monitors";
import type { ReadingContext, StoryMoment, Watcher } from "./signal";
import type { FolderData, SavedData, WatchData } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Fetch a user's Watch from the Veilla backend.
 *
 * Anonymous calls hit the public CDN cache (60s revalidate). Authenticated
 * calls forward the Supabase access token so the backend can return owner-
 * only state in the response (and bypass the cache via private Cache-Control).
 *
 * @throws Response if the user doesn't exist (404), the watch is private
 *                  to the viewer (401/403), or the backend errors.
 */
export async function fetchWatch(
  slug: string,
  windowHours: number = 24,
  accessToken?: string,
): Promise<WatchData> {
  const url = `${API_URL}/users/${encodeURIComponent(slug)}/watch?window_hours=${windowHours}`;

  const headers: HeadersInit = {};
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  // Authed responses are user-specific; opt out of the shared Next.js fetch
  // cache so one user can't see another's owner state.
  const res = await fetch(url, {
    headers,
    ...(accessToken ? { cache: "no-store" } : { next: { revalidate: 60 } }),
  });

  if (!res.ok) {
    throw res;
  }

  return res.json();
}

/**
 * Fetch the authenticated user's saved-stories library.
 *
 * Always private (per-user) — no CDN cache, requires a Bearer token.
 * Returns every save the user has ever made, sorted saved_at DESC.
 *
 * @throws Response if the call fails (401, 403, 5xx, etc.).
 */
export async function fetchSaved(accessToken: string): Promise<SavedData> {
  const res = await fetch(`${API_URL}/me/saved`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    throw res;
  }

  return res.json();
}

/**
 * Fetch the full content of a single manual folder, plus the user's
 * complete folder list (so the contextual sidebar can
 * render everything without an extra round-trip).
 *
 * @throws Response if the folder doesn't exist, the user has no access
 *                  (both surface as 404 to avoid existence leaks), or
 *                  the backend errors.
 */
export async function fetchFolder(
  folderId: string,
  accessToken: string,
): Promise<FolderData> {
  const res = await fetch(
    `${API_URL}/me/folders/${encodeURIComponent(folderId)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    },
  );

  if (!res.ok) {
    throw res;
  }

  return res.json();
}

/**
 * Fetch the authenticated user's persistent preferences (= default
 * `Advanced`-shaped filter). Used by the Settings page to seed the form.
 *
 * Returns the empty default when the user has never saved preferences.
 *
 * @throws Response on 401/403/5xx.
 */
export async function fetchPreferences(
  accessToken: string,
): Promise<Advanced> {
  const res = await fetch(`${API_URL}/me/preferences`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw res;
  return res.json();
}

/* ─────────── Notifications ─────────── */

/** Discriminated by `type` — the SPA renders each type's payload
 *  shape with a dedicated row component. Unknown future types should
 *  degrade to a generic "you have a notification" line. */
export type NotificationType = "story_update";

export interface NotificationItem {
  id: number;
  type: NotificationType | string;
  payload: Record<string, unknown>;
  created_at: string | null;
  read_at: string | null;
}

export interface NotificationsPayload {
  notifications:  NotificationItem[];
  unread_count:   number;
  next_before_id: number | null;
}

export async function fetchNotifications(
  accessToken: string,
  before_id?: number,
): Promise<NotificationsPayload> {
  const url = new URL(`${API_URL}/me/notifications`);
  if (before_id) url.searchParams.set("before_id", String(before_id));
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw res;
  return res.json();
}

/** Per-type channel prefs. Flipping both `in_app` and `email` off
 *  mutes the type entirely. Server normalizes missing keys to
 *  defaults, so GET always returns the full canonical shape. */
export interface NotifChannels {
  in_app: boolean;
  email:  boolean;
}
/** Followed-stories prefs carry one extra sub-toggle:
 *  - `include_new_articles` (default false) controls whether the user
 *     gets pinged for raw new articles attached to a followed story.
 *     When false, only `story_update` events (synthesized deltas) fire.
 *     When true, every new article triggers a notification too. */
export interface StoryFollowChannels extends NotifChannels {
  include_new_articles: boolean;
}
export interface NotifPrefs {
  story_follow: StoryFollowChannels;
}

export async function fetchNotifPrefs(
  accessToken: string,
): Promise<NotifPrefs> {
  const res = await fetch(`${API_URL}/me/notif-prefs`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw res;
  return res.json();
}


/* ─────────── Monitors and Signal ─────────── */

/** GET a per-user resource with the caller's token, never cached.
 *  @throws Response on any non-2xx. */
async function getMine<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) throw res;
  return res.json();
}

/** The monitors the reader follows, with their health. */
export const fetchMonitors = (accessToken: string) =>
  getMine<Monitor[]>("/me/monitors", accessToken);

/** One followed monitor, its fetches of the last day, its latest articles. */
export const fetchMonitor = (id: number, accessToken: string) =>
  getMine<{ monitor: Monitor; runs: MonitorRun[]; items: MonitorItem[] }>(
    `/me/monitors/${id}`,
    accessToken,
  );

export const fetchContext = (accessToken: string) =>
  getMine<ReadingContext>("/me/signal/context", accessToken);

export const fetchWatchers = (accessToken: string) =>
  getMine<Watcher[]>("/me/signal/watchers", accessToken);

export const fetchWatcher = (id: number, accessToken: string) =>
  getMine<Watcher>(`/me/signal/watchers/${id}`, accessToken);

/** The last week's story moments, newest first. */
export const fetchDecisions = (accessToken: string) =>
  getMine<StoryMoment[]>("/me/signal/decisions", accessToken);
