"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Tracks the count of articles fetched into the user's feed lens since
 * the last `reset()` (= last pill click / mount). Drives the "X nouveaux
 * articles — actualiser" pill at the top of /watch.
 *
 * # Source of truth
 *
 * Counts are computed server-side from `articles.fetched_at` via the
 * `/users/{slug}/new-articles-count?since=<iso>` catch-up endpoint —
 * NOT from accumulating broadcasts. Why: Supabase Realtime broadcasts
 * are ephemeral and at-most-once. When the browser tab sits inactive
 * for more than ~30 seconds, the OS / browser throttles the WebSocket;
 * broadcasts emitted by the worker during that window are dropped on
 * the floor and we never see them. If we just summed broadcasts, the
 * count would silently lag the real number of new articles. Users left
 * the tab open for an hour would see "1 nouveau article" while the
 * worker had actually pushed 50.
 *
 * # How the triggers fit
 *
 * Three things can trigger a refetch (= "go re-read the count from
 * the DB now"):
 *   1. Initial mount — establish a baseline.
 *   2. A `new_articles` broadcast arrives — fast-path nudge. We don't
 *      trust the broadcast's count number; we just use it as a signal
 *      to re-query, which then returns the authoritative cumulative
 *      total since `lastResetAt`.
 *   3. The tab becomes visible again (`visibilitychange` → visible) —
 *      catches up after the WebSocket was throttled / asleep.
 *
 * # Reset
 *
 * `reset()` bumps `lastResetAt` to NOW and clears the count to 0. The
 * SPA calls it from the pill click handler (after triggering
 * `router.refresh()` to pull the new articles into the watch payload).
 */
export function useNewArticles(slug: string | null): {
  count: number;
  reset: () => void;
} {
  const [count, setCount] = React.useState(0);
  const [lastResetAt, setLastResetAt] = React.useState<string>(() =>
    new Date().toISOString(),
  );

  // The fetch function depends on slug + lastResetAt. We capture it in a
  // ref so the broadcast/visibility effects can call the freshest version
  // without re-subscribing the channel on every reset.
  const refetchRef = React.useRef<() => Promise<void>>(async () => {});

  React.useEffect(() => {
    refetchRef.current = async () => {
      if (!slug) return;
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        const headers: HeadersInit = {};
        if (session?.access_token) {
          headers["Authorization"] = `Bearer ${session.access_token}`;
        }
        const url = `${API_URL}/users/${encodeURIComponent(
          slug,
        )}/new-articles-count?since=${encodeURIComponent(lastResetAt)}`;
        const res = await fetch(url, { headers, cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: number };
        setCount(typeof data.count === "number" ? data.count : 0);
      } catch (err) {
        // Network error / offline — keep current count; the next trigger
        // (broadcast, visibilitychange, next mount) will retry. Warn
        // (not error) since it's recoverable and routine.
        console.warn("[useNewArticles] catch-up fetch failed", err);
      }
    };
  }, [slug, lastResetAt]);

  // Initial fetch + refetch when `slug` or `lastResetAt` changes.
  React.useEffect(() => {
    refetchRef.current();
  }, [slug, lastResetAt]);

  // Broadcast subscription — used purely as a "wake up, re-query the
  // DB" nudge. We deliberately ignore the broadcast's payload.count
  // because it's the per-pass count, not the cumulative since-reset
  // count we actually want to show.
  React.useEffect(() => {
    if (!slug) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`user:${slug}`)
      .on("broadcast", { event: "new_articles" }, () => {
        refetchRef.current();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [slug]);

  // Tab-visibility catch-up — covers the broadcast-loss case when the
  // socket was throttled in a background tab.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refetchRef.current();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const reset = React.useCallback(() => {
    // Bump `lastResetAt` to NOW; the effect-driven refetch will then
    // ask the backend for the count "since NOW", which is 0 (no race:
    // articles are added in the future, never the past).
    setLastResetAt(new Date().toISOString());
    setCount(0);
  }, []);

  return { count, reset };
}
