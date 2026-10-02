"use client";

import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";
import { overBudget, type Watcher } from "@/lib/signal";
import { cn } from "@/lib/utils";

/**
 * Says that an agent is missing news: its daily budget is spent, or it
 * skipped stories it could not reach while they were fresh. Nothing when
 * it is within budget.
 *
 * `compact` is the one-line form for a card; the full form adds what to
 * do about it, for the agent's own page.
 */
export function BudgetWarning({ watcher, compact = false }: { watcher: Watcher; compact?: boolean }) {
  const t = useTranslations("signal.budget");
  if (!overBudget(watcher)) return null;

  const parts = [
    watcher.judged_24h >= watcher.daily_budget &&
      t("spent", { used: watcher.judged_24h, budget: watcher.daily_budget }),
    watcher.skipped_24h > 0 && t("skipped", { n: watcher.skipped_24h }),
  ].filter(Boolean);

  return (
    <div
      role="status"
      className={cn(
        "flex gap-2 text-priority-text",
        compact ? "items-center text-[11.5px]" : "items-start rounded-lg bg-priority-soft px-3 py-2.5 text-[12.5px]",
      )}
    >
      <AlertTriangle size={compact ? 12 : 14} strokeWidth={1.8} aria-hidden className={cn("shrink-0", !compact && "mt-0.5")} />
      <div className="min-w-0">
        <p className={cn(compact && "truncate", !compact && "font-medium")}>{parts.join(" · ")}</p>
        {!compact && <p className="mt-0.5 text-text-2">{t("hint")}</p>}
      </div>
    </div>
  );
}
