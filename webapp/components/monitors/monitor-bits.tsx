"use client";

import { useTranslations } from "next-intl";
import { Newspaper, Rss, type LucideIcon } from "lucide-react";
import { HEALTH_STYLES, type MonitorHealth, type MonitorTemplate } from "@/lib/monitors";
import { cn } from "@/lib/utils";

export const TEMPLATE_ICONS: Record<MonitorTemplate, LucideIcon> = {
  rss: Rss,
  google_news: Newspaper,
};

export function HealthPill({ health, className }: { health: MonitorHealth; className?: string }) {
  const t = useTranslations("monitors.health");
  return (
    <span
      className={cn(
        "inline-flex items-center h-[22px] px-2.5 rounded-full",
        "text-[11.5px] font-medium whitespace-nowrap",
        HEALTH_STYLES[health],
        className,
      )}
    >
      {t(health)}
    </span>
  );
}

export function TemplateLabel({ template }: { template: MonitorTemplate }) {
  const t = useTranslations("monitors.template");
  const Icon = TEMPLATE_ICONS[template];
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <Icon size={12} strokeWidth={1.8} aria-hidden className="shrink-0 text-text-4" />
      <span className="truncate">{t(template)}</span>
    </span>
  );
}
