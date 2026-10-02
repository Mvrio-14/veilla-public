"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Subscribes to the worker's heartbeat broadcast on `worker:heartbeat`
 * AND falls back to a server-side catch-up query when broadcasts are
 * dropped. Drives the "Mis à jour à HH:MM" indicator on /watch.
 *
 * # Why both broadcast and catch-up
 *
 * Supabase Realtime broadcasts are at-most-once and ephemeral. When a
 * tab sits in the background, the browser throttles the underlying
 * WebSocket; any heartbeat the worker emits during that throttle window
 * is dropped silently. Same problem as `useNewArticles` — without a
 * catch-up path, "Mis à jour" would freeze at whatever timestamp the
 * tab caught before going inactive.
 *
 * The catch-up endpoint `/worker/last-pass-ts` returns
 * `MAX(feeds.updated_at)` from the DB — an authoritative timestamp
 * that tracks the worker's last activity to within a few seconds.
 *
 * # Triggers
 *
 * Four moments fetch a fresh server-side timestamp:
 *   1. Initial mount — covers tabs opened a while ago whose `initialTs`
 *      prop is now stale.
 *   2. A `pass_complete` broadcast arrives — fast-path on the happy
 *      path (tab active, WS healthy). We trust the broadcast's payload
 *      directly here since it's the same shape the server would
 *      return; the catch-up endpoint isn't called.
 *   3. The tab becomes visible again — catches up after WS throttling.
 *   4. The 30s ticker — purely cosmetic (forces a re-render so
 *      relative-time formatting like "il y a 3 min" stays fresh
 *      without touching the network).
 *
 * # Monotonic
 *
 * Updates always move forward in time (`incoming > prev`). Cheap
 * protection against any out-of-order delivery between broadcasts and
 * the catch-up fetch.
 */
export function useLastWorkerCheck(initialTs: string | null): string | null {
  const [ts, setTs] = React.useState<string | null>(initialTs);
  const [, forceRerender] = React.useReducer((x: number) => x + 1, 0);

  /** Fetch the authoritative timestamp. Touches no React state, so the
   *  mount effect below can apply it from a promise callback.
   *
   *  Returns null on any failure — offline, API down, CORS, a network
   *  blip. The caller keeps whatever it had; the next trigger
   *  (broadcast, visibilitychange, mount) retries. */
  const fetchTs = React.useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(`${API_URL}/worker/last-pass-ts`, {
        cache: "no-store",
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { ts?: string | null };
      return data.ts ?? null;
    } catch (err) {
      // Warn, not error: recoverable and routine.
      console.warn("[useLastWorkerCheck] catch-up fetch failed", err);
      return null;
    }
  }, []);

  /** Only ever move forward in time — cheap protection against a
   *  broadcast and a catch-up fetch arriving out of order. */
  const applyTs = React.useCallback((incoming: string | null) => {
    if (!incoming) return;
    setTs((prev) => (!prev || incoming > prev ? incoming : prev));
  }, []);

  /** Used on visibility-change to recover from missed broadcasts. */
  const refetch = React.useCallback(async () => {
    applyTs(await fetchTs());
  }, [fetchTs, applyTs]);

  // Initial catch-up so stale `initialTs` props get refreshed quickly.
  React.useEffect(() => {
    let alive = true;
    void fetchTs().then((incoming) => {
      if (alive) applyTs(incoming);
    });
    return () => {
      alive = false;
    };
  }, [fetchTs, applyTs]);

  // Broadcast subscription — happy-path fast-update.
  React.useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("worker:heartbeat")
      .on(
        "broadcast",
        { event: "pass_complete" },
        (msg) => {
          const incoming = (msg.payload as { ts?: string } | null)?.ts;
          if (typeof incoming !== "string") return;
          setTs((prev) => (!prev || incoming > prev ? incoming : prev));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // Tab-visibility catch-up — covers the broadcast-loss case.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refetch();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);

  // 30s ticker for relative-time formatting (no network).
  React.useEffect(() => {
    const tick = setInterval(() => forceRerender(), 30_000);
    return () => clearInterval(tick);
  }, []);

  return ts;
}
