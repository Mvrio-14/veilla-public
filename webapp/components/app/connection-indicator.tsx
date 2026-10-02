"use client";

import { useTranslations } from "next-intl";
import { useRealtimeConnectionState } from "@/lib/realtime/use-realtime-event";
import { cn } from "@/lib/utils";

/**
 * Ambient WebSocket connection dot — lives in the topbar next to the
 * user menu. Subtle by design: the user shouldn't notice it when
 * things work, only when something is off.
 *
 * Color contract:
 *   - green    → connected, events flowing
 *   - amber    → connecting (initial handshake)
 *   - red      → disconnected (network drop, Supabase issue)
 *   - hidden   → idle (provider not initialized yet — boot flicker)
 *
 * Tooltip on hover surfaces the status in plain text so screen
 * readers + curious users can confirm.
 */
export function ConnectionIndicator() {
  const state = useRealtimeConnectionState();
  const t = useTranslations("connection");

  if (state === "idle") return null;

  const dotClass = {
    connecting:   "bg-priority animate-pulse",
    connected:    "bg-good",
    disconnected: "bg-hot",
  }[state];

  const label = t(state);

  return (
    <span
      className="inline-flex items-center justify-center w-6 h-6 shrink-0"
      title={label}
      aria-label={label}
      role="status"
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          dotClass,
        )}
      />
    </span>
  );
}
