"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, SlidersHorizontal, User } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Vertical tabs sidebar for the /settings shell. Each tab is a route
 * (/settings/preferences, /settings/notifications, etc.) so the browser back /
 * forward stack works naturally and deep-links resolve.
 *
 * Lives next to the actual settings content (rendered by each tab's
 * page.tsx) inside `app/(app)/settings/layout.tsx`. The active tab is
 * highlighted via the URL prefix match.
 */
export function SettingsTabs() {
  const t = useTranslations("settings");
  const pathname = usePathname();

  const tabs: {
    href: string;
    label: string;
    icon: typeof SlidersHorizontal;
  }[] = [
    {
      href: "/settings/preferences",
      label: t("tabs.preferences"),
      icon: SlidersHorizontal,
    },
    {
      href: "/settings/notifications",
      label: t("tabs.notifications"),
      icon: Bell,
    },
    { href: "/settings/profile", label: t("tabs.profile"), icon: User },
  ];

  return (
    <aside
      aria-label={t("sectionsAriaLabel")}
      className={cn(
        "shrink-0 w-[220px] border-r border-border bg-bg-elev",
        "flex flex-col py-6 px-3 gap-0.5",
      )}
    >
      <div className="px-2.5 pb-3 text-[11px] uppercase tracking-[0.06em] font-semibold text-text-3">
        {t("title")}
      </div>
      {tabs.map(({ href, label, icon: Icon }) => {
        const active =
          pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md",
              "text-[13px] font-medium",
              "transition-colors duration-100",
              active
                ? "bg-bg-active text-text font-semibold"
                : "text-text-2 hover:bg-bg-hover hover:text-text",
            )}
          >
            <Icon
              size={13}
              strokeWidth={active ? 2 : 1.6}
              className={active ? "text-text" : "text-text-3"}
              aria-hidden
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </aside>
  );
}
