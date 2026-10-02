"use client";

import { useTranslations } from "next-intl";
import type { Verdict } from "@/lib/signal";
import { cn } from "@/lib/utils";

/**
 * One agent's verdict on a story, as a small tag: the agent's name,
 * styled by what it decided. Kept is tinted, dropped is grey, and not
 * judged is only outlined, so a row of them reads at a glance without
 * any of the three being mistaken for another.
 */
export type Mark = Verdict | "not_judged";

const STYLES: Record<Mark, string> = {
  kept: "bg-[color-mix(in_oklab,var(--good)_13%,transparent)] text-good border-transparent",
  dropped: "bg-bg-sub text-text-3 border-transparent",
  not_judged: "bg-transparent text-text-4 border-dashed border-border-strong",
};

export function VerdictMark({ mark, agent }: { mark: Mark; agent: string }) {
  const t = useTranslations("signal.verdicts");
  return (
    <span
      title={`${agent} · ${t(mark)}`}
      className={cn(
        "inline-flex items-center gap-1.5 h-[21px] px-2 rounded-full border",
        "text-[11px] whitespace-nowrap max-w-[200px]",
        STYLES[mark],
      )}
    >
      <span className="font-semibold shrink-0">{t(`short.${mark}`)}</span>
      <span className="truncate">{agent}</span>
    </span>
  );
}
