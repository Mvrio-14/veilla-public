"use client";

import * as React from "react";
import { ConnectionIndicator } from "@/components/app/connection-indicator";
import { NotifBell } from "@/components/app/notif-bell";
import { UserMenu } from "@/components/watch/user-menu";
import { useTranslations } from "next-intl";
import { useSidebar } from "@/lib/sidebar-context";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

/**
 * Shared app topbar — visible on every authenticated route under (app)/.
 *
 * Controls only. The brand sits at the top of the sidebar, level with
 * this bar; the bar's first control is the sidebar toggle, right beside
 * the sidebar it collapses. On the right, the signals that must stay
 * visible without a click — connection state and unread notifications —
 * and the account menu, which also holds the theme switch.
 *
 * Layout: ▮ toggle · … · ▸ connection · bell · avatar
 */
export function AppTopbar() {
  const t = useTranslations("rail");
  const { collapsed, toggle } = useSidebar();
  // Slug drives the Realtime channel for the notif bell.
  const [slug, setSlug] = React.useState<string | null>(null);

  // Resolve the user's slug once on mount via /me. Done client-side so
  // the layout's first paint isn't blocked on the API round-trip; the
  // bell pops in a beat after the rest of the shell.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) return;
        const res = await fetch(`${API_URL}/me`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store",
        });
        if (!res.ok) return;
        const me = await res.json();
        if (cancelled) return;
        setSlug(me.slug ?? null);
      } catch {
        // Best-effort — the topbar still renders without the bell.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="h-11 flex items-center gap-2.5 px-3 border-b border-border shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={collapsed}
        aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        className={cn(
          "grid place-items-center w-7 h-7 rounded-md cursor-pointer shrink-0",
          "text-text-3 hover:text-text hover:bg-bg-hover",
          "transition-colors duration-100",
        )}
      >
        {/* One icon, not two: the inner column drains instead of swapping
         *  drawings, so the toggle reads as the same object changing
         *  state rather than a different button appearing. */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="3" y="4.5" width="18" height="15" rx="2" />
          <path d="M9 4.5v15" />
          <rect
            className="sidebar-toggle-fill"
            x="3.9"
            y="5.4"
            width="4.2"
            height="13.2"
            rx="1.2"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-1 shrink-0">
        <ConnectionIndicator />
        <NotifBell slug={slug} />
        <UserMenu />
      </div>
    </header>
  );
}
