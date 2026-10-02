"use client";

import * as React from "react";
import type {
  RealtimeChannel,
  RealtimePostgresChangesPayload,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type {
  FolderRow,
  FolderStoryRow,
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeEventType,
  ViewRow,
} from "./types";

/**
 * Central Supabase Realtime bus for the authenticated app shell.
 *
 * Mounted once at the (app) layout level, it opens a single channel
 * that listens for Postgres Changes on the three tables we care about
 * (`folders`, `views`, `folder_stories`). RLS policies from migration
 * 0032 filter the events server-side so each client only receives
 * rows it has the right to see — no client-side filtering needed.
 *
 * Components subscribe to specific event types via
 * `useRealtimeEvent(type, callback)` and the provider dispatches in
 * a tight loop. The provider exposes `connectionState` for the
 * status dot in the rail; that field flips through
 * connecting → connected → disconnected as Supabase reports.
 *
 * Lifecycle:
 *   - mount  → open channel, set state to "connecting"
 *   - SUBSCRIBED → state = "connected"
 *   - CLOSED / ERROR / TIMED_OUT → state = "disconnected"; Supabase
 *     auto-reconnects, the next SUBSCRIBED flips it back
 *   - unmount → remove channel
 *
 * The provider deliberately wires NO business logic to incoming events;
 * it just exposes the bus. Consumers such as `RealtimeRefresher`
 * subscribe to the event types they care about.
 */

type Listener = (event: RealtimeEvent) => void;

type RealtimeContextValue = {
  connectionState: RealtimeConnectionState;
  subscribe: (type: RealtimeEventType, fn: Listener) => () => void;
};

const RealtimeContext = React.createContext<RealtimeContextValue | null>(null);

export function useRealtimeContext(): RealtimeContextValue {
  const ctx = React.useContext(RealtimeContext);
  if (!ctx) {
    throw new Error(
      "useRealtimeContext must be used inside <RealtimeProvider>",
    );
  }
  return ctx;
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  // Starts at "connecting", not "idle": the effect below subscribes on
  // mount, so the provider is never idle while it is alive. Saying
  // "idle" first and correcting it inside the effect meant one render
  // claiming a state the component was never in.
  const [connectionState, setConnectionState] =
    React.useState<RealtimeConnectionState>("connecting");

  // The listener map lives in a ref so updates don't trigger re-renders
  // of the provider (only the consumers via their own state). One Set
  // per event type — order of dispatch is insertion order.
  const listenersRef = React.useRef<
    Map<RealtimeEventType, Set<Listener>>
  >(new Map());

  const subscribe = React.useCallback(
    (type: RealtimeEventType, fn: Listener) => {
      let bucket = listenersRef.current.get(type);
      if (!bucket) {
        bucket = new Set();
        listenersRef.current.set(type, bucket);
      }
      bucket.add(fn);
      return () => {
        bucket?.delete(fn);
      };
    },
    [],
  );

  const dispatch = React.useCallback((event: RealtimeEvent) => {
    const bucket = listenersRef.current.get(event.type);
    if (!bucket || bucket.size === 0) return;
    for (const fn of bucket) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[realtime] listener for ${event.type} threw`, err);
      }
    }
  }, []);

  React.useEffect(() => {
    const supabase = createClient();

    // Single channel for the whole app. Channel name is arbitrary
    // ("app-realtime" is fine) — RLS scopes the events to this user.
    const channel: RealtimeChannel = supabase
      .channel("app-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "folders" },
        (payload) => {
          const ev = mapFolderEvent(payload);
          if (ev) dispatch(ev);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "views" },
        (payload) => {
          const ev = mapViewEvent(payload);
          if (ev) dispatch(ev);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "folder_stories" },
        (payload) => {
          const ev = mapFolderStoryEvent(payload);
          if (ev) dispatch(ev);
        },
      );

    channel.subscribe((status) => {
      // Supabase status codes:
      //   SUBSCRIBED            → channel active
      //   CHANNEL_ERROR         → server-side error, transient
      //   TIMED_OUT             → connect handshake didn't complete
      //   CLOSED                → channel closed (manual or socket drop)
      // Auto-reconnect is handled by supabase-js — we just reflect the
      // current state into the UI dot.
      if (status === "SUBSCRIBED") {
        setConnectionState("connected");
      } else if (
        status === "CHANNEL_ERROR"
        || status === "TIMED_OUT"
        || status === "CLOSED"
      ) {
        setConnectionState("disconnected");
      }
    });

    return () => {
      supabase.removeChannel(channel);
      setConnectionState("idle");
    };
  }, [dispatch]);

  const value = React.useMemo<RealtimeContextValue>(
    () => ({ connectionState, subscribe }),
    [connectionState, subscribe],
  );

  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Payload → typed event mappers. Supabase's PostgresChangesPayload
 * shape is loose ({ eventType, new, old, ... }) so we narrow it once
 * here and emit our typed RealtimeEvent. Returning null when the
 * payload's shape is unexpected (defensive — should never happen
 * with our schema) so the dispatcher silently drops it.
 * ──────────────────────────────────────────────────────────────── */

function mapFolderEvent(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
): RealtimeEvent | null {
  switch (payload.eventType) {
    case "INSERT":
      return { type: "folders.insert", row: payload.new as FolderRow };
    case "UPDATE":
      return {
        type: "folders.update",
        row: payload.new as FolderRow,
        old: payload.old as Partial<FolderRow>,
      };
    case "DELETE":
      return { type: "folders.delete", old: payload.old as Partial<FolderRow> };
    default:
      return null;
  }
}

function mapViewEvent(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
): RealtimeEvent | null {
  switch (payload.eventType) {
    case "INSERT":
      return { type: "views.insert", row: payload.new as ViewRow };
    case "UPDATE":
      return {
        type: "views.update",
        row: payload.new as ViewRow,
        old: payload.old as Partial<ViewRow>,
      };
    case "DELETE":
      return { type: "views.delete", old: payload.old as Partial<ViewRow> };
    default:
      return null;
  }
}

function mapFolderStoryEvent(
  payload: RealtimePostgresChangesPayload<Record<string, unknown>>,
): RealtimeEvent | null {
  switch (payload.eventType) {
    case "INSERT":
      return {
        type: "folder_stories.insert",
        row: payload.new as FolderStoryRow,
      };
    case "DELETE":
      return {
        type: "folder_stories.delete",
        old: payload.old as Partial<FolderStoryRow>,
      };
    default:
      // UPDATE on folder_stories shouldn't happen — the table is
      // composite-key + added_at, with no editable columns. Skip.
      return null;
  }
}
