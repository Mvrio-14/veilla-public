"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bell, BellRing } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtRelative } from "@/lib/format";
import type { NotificationItem } from "@/lib/api";

/**
 * Single notification row, shared between the bell popover (only
 * consumer for now). Encapsulates the type→href + type→icon +
 * type→strings mapping so each notification type stays self-contained.
 *
 * Click semantics:
 *   - The row is a Link to the source content (a story today).
 *   - `onClick` fires alongside navigation — used by the popover to
 *     mark-as-read optimistically and to close the popover.
 *
 * Unknown future types degrade to a generic "you have a notification"
 * line linking to `/watch` (= the user's default landing).
 */
export function NotificationRow({
  notification,
  onClick,
  locale,
}: {
  notification: NotificationItem;
  /** Fires on left-click. Use to mark-as-read + close any host
   *  popover. The Link's navigation still happens. */
  onClick?: () => void;
  locale: string;
}) {
  const t = useTranslations("notifications");
  const isUnread = !notification.read_at;
  const { href, icon, title, body } = useRowContent(notification, t);

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        "border-b border-border last:border-b-0",
        "transition-colors",
        isUnread
          ? "bg-accent-soft/30 hover:bg-accent-soft/50"
          : "hover:bg-bg-hover",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "shrink-0 inline-flex items-center justify-center",
          "w-7 h-7 rounded-full mt-0.5",
          isUnread ? "bg-accent text-bg" : "bg-bg-hover text-text-3",
        )}
      >
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={cn(
              "text-[12.5px] truncate",
              isUnread ? "text-text font-medium" : "text-text-2",
            )}
          >
            {title}
          </p>
          <span className="shrink-0 text-[10.5px] text-text-4 tabular-nums">
            {notification.created_at
              ? fmtRelative(notification.created_at, locale)
              : ""}
          </span>
        </div>
        {body && (
          <p
            className={cn(
              "text-[11.5px] leading-snug mt-0.5 line-clamp-2",
              isUnread ? "text-text-2" : "text-text-3",
            )}
          >
            {body}
          </p>
        )}
      </div>
    </Link>
  );
}

/** Pick the icon, href, and human-readable strings for a given
 *  notification based on its type. Unknown types degrade to a generic
 *  "you have a notification" line linking to /watch. */
function useRowContent(
  notification: NotificationItem,
  t: ReturnType<typeof useTranslations<"notifications">>,
): { href: string; icon: React.ReactNode; title: string; body: string | null } {
  const p = notification.payload;

  switch (notification.type) {
    case "story_update": {
      const storyId = typeof p.story_id === "number" ? p.story_id : null;
      const storyTitle = (p.story_title as string) || t("genericStory");
      const kind = (p.kind as string) || "";
      const articleTitle = (p.article_title as string) || "";
      const updateText = (p.update_text as string) || "";
      const source = (p.source as string) || "";

      const title =
        kind === "new_update"
          ? t("rowStoryUpdate", { story: storyTitle })
          : t("rowStoryNewArticle", { story: storyTitle });
      const body =
        kind === "new_update"
          ? updateText
          : articleTitle
            ? source
              ? `${articleTitle} — ${source}`
              : articleTitle
            : null;
      return {
        href: storyId !== null ? `/watch?story=${storyId}` : "/watch",
        icon: <BellRing size={12} strokeWidth={1.9} fill="currentColor" />,
        title,
        body,
      };
    }

    default:
      return {
        href: "/watch",
        icon: <Bell size={12} strokeWidth={1.8} />,
        title: t("rowGeneric"),
        body: null,
      };
  }
}
