/**
 * Realtime event taxonomy.
 *
 * Veilla listens to two flavors of events:
 *
 * 1. Postgres Changes (table-level INSERT/UPDATE/DELETE on `folders`,
 *    `views`, `folder_stories`). Filtered server-side by the SELECT
 *    RLS policies at the end of the baseline schema — clients only receive events
 *    on rows they're allowed to see.
 *
 * 2. Broadcast messages — custom channel-based messages pushed by the
 *    worker (e.g. its heartbeat after each pass). No DB table involved.
 *
 * The provider funnels both into a uniform `RealtimeEvent` union that
 * components consume via `useRealtimeEvent(type, callback)`.
 */

/** A Postgres row-change event. Mirrors Supabase's payload shape but
 *  re-typed per table for downstream consumers. */
export type FolderRow = {
  id: string;
  name: string;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ViewRow = {
  id: string;
  name: string;
  user_id: string | null;
  criteria: unknown;
  created_at: string;
  updated_at: string;
};

export type FolderStoryRow = {
  folder_id: string;
  story_id: number;
  added_at: string;
};

/** Union of all events the provider emits. The `type` discriminator
 *  drives the `useRealtimeEvent` typing — callers get a typed payload
 *  for free. */
export type RealtimeEvent =
  | { type: "folders.insert"; row: FolderRow }
  | { type: "folders.update"; row: FolderRow; old: Partial<FolderRow> }
  | { type: "folders.delete"; old: Partial<FolderRow> }
  | { type: "views.insert"; row: ViewRow }
  | { type: "views.update"; row: ViewRow; old: Partial<ViewRow> }
  | { type: "views.delete"; old: Partial<ViewRow> }
  | { type: "folder_stories.insert"; row: FolderStoryRow }
  | { type: "folder_stories.delete"; old: Partial<FolderStoryRow> };

export type RealtimeEventType = RealtimeEvent["type"];

/** Connection lifecycle states surfaced by the provider. The UI dot
 *  reads this directly. */
export type RealtimeConnectionState =
  | "idle"          // hook hasn't fired yet
  | "connecting"    // channel sub in flight
  | "connected"     // channel SUBSCRIBED
  | "disconnected"; // CLOSED / CHANNEL_ERROR / TIMED_OUT
