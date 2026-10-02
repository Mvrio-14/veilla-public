"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BudgetWarning } from "@/components/signal/budget-warning";
import { NewAgentDialog } from "@/components/signal/new-agent-dialog";
import { useCanWrite } from "@/lib/auth/can-write";
import { fmtSmartClock } from "@/lib/format";
import type { Watcher } from "@/lib/signal";
import { cn } from "@/lib/utils";

/**
 * The Agents screen — every standing request, and what each has done
 * over the last week.
 *
 * An agent is read by its request, not its name: the name is a label a
 * person gave it, the request is what the model is actually told. So the
 * request is on the card, in full up to three lines.
 *
 * The tally puts kept before dropped and both side by side: an agent that
 * keeps nothing is either very precise or broken, and only the second
 * number says which.
 */
export function AgentsView({ agents }: { agents: Watcher[] }) {
  const t = useTranslations("signal.agents");
  const nActive = agents.filter((a) => a.status === "active").length;
  const canWrite = useCanWrite();
  const [creating, setCreating] = React.useState(false);

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-7 pt-8 pb-10">
        <div className="flex items-start gap-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-normal tracking-[-0.02em] leading-tight">
              {t("title")}
            </h1>
            <p className="mt-1 text-[12px] text-text-3">
              {t("activeOf", { active: nActive, total: agents.length })}
            </p>
          </div>
          <div className="flex-1" />
          <Button
            variant="solid"
            size="lg"
            className="gap-2"
            disabled={!canWrite}
            onClick={() => setCreating(true)}
          >
            <Plus size={13} strokeWidth={2} aria-hidden />
            {t("create")}
          </Button>
        </div>
        <p className="mt-4 max-w-[640px] text-[13px] leading-relaxed text-text-2">{t("intro")}</p>

        {agents.length === 0 ? (
          <p className="pt-10 text-center text-[12px] text-text-4">{t("empty")}</p>
        ) : (
          <div className="mt-6 grid gap-2">
            {agents.map((agent) => (
              <AgentCard key={agent.id} agent={agent} />
            ))}
          </div>
        )}
      </div>
      <NewAgentDialog open={creating} onOpenChange={setCreating} />
    </main>
  );
}

function AgentCard({ agent }: { agent: Watcher }) {
  const t = useTranslations("signal.agents");
  const locale = useLocale();
  const paused = agent.status === "paused";

  return (
    <Link
      href={`/signal/agents/${agent.id}`}
      className={cn(
        "block rounded-lg border border-border bg-bg-elev px-4 py-3.5",
        "transition-colors duration-100 hover:border-border-strong hover:bg-bg-sub",
      )}
    >
      <div className="flex items-baseline gap-2.5">
        <span
          className={cn(
            "min-w-0 truncate text-[15px] font-medium tracking-[-0.01em]",
            paused ? "text-text-3" : "text-text",
          )}
        >
          {agent.name}
        </span>
        {paused && (
          <span className="shrink-0 px-2 py-px rounded-full bg-bg-sub text-[11px] text-text-3">
            {t("paused")}
          </span>
        )}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-text-3 line-clamp-3">
        {agent.request}
      </p>
      <div className="flex items-center gap-3 mt-3 text-[11.5px] text-text-4 whitespace-nowrap">
        <span>
          {agent.monitor_ids.length
            ? t("scopeSome", { n: agent.monitor_ids.length })
            : t("scopeAll")}
        </span>
        <span aria-hidden>·</span>
        <span>
          <span className="text-good">{t("kept", { n: agent.kept_7d })}</span>
          {" · "}
          {t("dropped", { n: agent.dropped_7d })}
          {" "}
          {t("week")}
        </span>
        <span className="flex-1" />
        {agent.last_kept_at && (
          <span>{t("lastKept", { when: fmtSmartClock(agent.last_kept_at, locale) })}</span>
        )}
      </div>
      <div className="mt-2 empty:hidden">
        <BudgetWarning watcher={agent} compact />
      </div>
    </Link>
  );
}
