"use client";

import * as React from "react";
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Tracks the unread notifications count for the bell badge in the
 * topbar/rail.
 *
 * # Source of truth
 *
 * Count is computed server-side via `GET /me/notifications` (returns
 * `unread_count`), NOT by accumulating broadcast payloads. Same
 * reasoning as `useNewArticles`: Supabase Realtime broadcasts are
 * at-most-once and ephemeral, so any nudge fired while the tab is
 * background-throttled is dropped. The catch-up endpoint gives an
 * authoritative count we can reconcile against.
 *
 * # Triggers
 *
 *   1. Initial mount — establish baseline.
 *   2. A `notification:new` broadcast arrives on `user:{slug}` — fast-
 *      path nudge. We don't trust the broadcast's `id` field; we just
 *      re-query the count.
 *   3. The tab becomes visible again — covers the WebSocket-throttled
 *      background-tab case.
 *
 * # Clear coordination
 *
 * Notifications are dismiss-on-handle: clicking a row deletes that notif,
 * and the bell's "Tout effacer" wipes them all. Callers should `refetch`
 * here after either action so the badge drops without waiting for the
 * next trigger. The server's `unread_count` is now just `COUNT(*)` over
 * the user's remaining rows — same semantics for this hook either way.
 */
export function useUnreadNotifications(slug: string | null): {
  unreadCount: number;
  refetch: () => Promise<void>;
} {
  const [unreadCount, setUnreadCount] = React.useState(0);

  const refetchRef = React.useRef<() => Promise<void>>(async () => {});

  React.useEffect(() => {
    refetchRef.current = async () => {
      if (!slug) return;
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const res = await fetch(`${API_URL}/me/notifications?limit=1`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { unread_count?: number };
        if (typeof data.unread_count === "number") {
          setUnreadCount(data.unread_count);
        }
      } catch (err) {
        console.warn("[useUnreadNotifications] catch-up fetch failed", err);
      }
    };
  }, [slug]);

  // Initial fetch + refetch on slug change (e.g., login).
  React.useEffect(() => {
    refetchRef.current();
  }, [slug]);

  // Broadcast subscription — `notification:new` is a "wake up, refetch"
  // nudge. We ignore the payload contents.
  React.useEffect(() => {
    if (!slug) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`user:${slug}`)
      .on("broadcast", { event: "notification:new" }, () => {
        refetchRef.current();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [slug]);

  // Visibility catch-up — covers the broadcast-loss case when the
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

  const refetch = React.useCallback(async () => {
    await refetchRef.current();
  }, []);

  return { unreadCount, refetch };
}
