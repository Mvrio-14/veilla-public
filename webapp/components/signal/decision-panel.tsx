"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, X } from "lucide-react";
import { ModelText } from "@/components/signal/model-text";
import { VerdictMark } from "@/components/signal/verdict-mark";
import { fmtSmartClock } from "@/lib/format";
import type { Decision, StoryMoment } from "@/lib/signal";
import { cn } from "@/lib/utils";

/**
 * Everything the agents decided about one story moment, and on what.
 *
 * Each decision shows its verdict and reason first, then, folded, exactly
 * what the agent was given: the label, the synthesis, the new articles,
 * and its earlier reason if it had already kept the story. A verdict can
 * only be judged against its input; showing the input is what turns
 * "the agent got it wrong" into "the request, or the scope, needs this
 * change".
 *
 * What the model wrote is set apart from the interface (`ModelText`).
 * Model, tokens and time sit last and small: they matter when auditing
 * spend, not when reading a verdict.
 */
export function DecisionPanel({
  moment,
  agentName,
  onClose,
}: {
  moment: StoryMoment;
  agentName: (id: number) => string;
  onClose: () => void;
}) {
  const t = useTranslations("signal.decisions.panel");
  const tc = useTranslations("common");

  return (
    <aside
      aria-label={t("ariaLabel")}
      className="w-[400px] shrink-0 border-l border-border bg-bg-elev flex flex-col min-h-0"
    >
      <div className="shrink-0 flex items-start gap-3 px-5 pt-5 pb-4 border-b border-border">
        <div className="min-w-0">
          <p className="text-[11px] text-text-3">{t("story", { id: moment.story_id })}</p>
          <h2 className="mt-1 text-[15px] font-medium leading-snug">{moment.label}</h2>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label={tc("close")}
          className="grid place-items-center w-7 h-7 -mr-1.5 rounded-md cursor-pointer text-text-3 hover:text-text hover:bg-bg-hover shrink-0"
        >
          <X size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border">
        {moment.decisions.map((decision) => (
          <DecisionSection
            key={decision.watcher_id}
            decision={decision}
            agent={agentName(decision.watcher_id)}
          />
        ))}
        {moment.not_judged.map((n) => (
          <section key={n.watcher_id} className="px-5 py-4">
            <VerdictMark mark="not_judged" agent={agentName(n.watcher_id)} />
            <p className="mt-2 text-[12.5px] leading-relaxed text-text-3">
              {t(`notJudged.${n.reason}`)}
            </p>
          </section>
        ))}
        {moment.decisions.length === 0 && moment.not_judged.length === 0 && (
          <p className="px-5 py-4 text-[12.5px] text-text-4">{t("noAgent")}</p>
        )}
      </div>
    </aside>
  );
}

function DecisionSection({ decision, agent }: { decision: Decision; agent: string }) {
  const t = useTranslations("signal.decisions.panel");
  const locale = useLocale();
  const [open, setOpen] = React.useState(false);
  const { input } = decision;

  return (
    <section className="px-5 py-4">
      <VerdictMark mark={decision.verdict} agent={agent} />
      <div className="mt-2.5">
        <DecisionReason decision={decision} />
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 mt-3 text-[11.5px] text-text-3 hover:text-text cursor-pointer"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.8}
          aria-hidden
          className={cn("transition-transform duration-100", open && "rotate-90")}
        />
        {t("input")}
      </button>

      {open && (
        <div className="mt-2 rounded-md border border-border bg-bg-sub px-3 py-2.5 text-[12px] leading-relaxed">
          <InputField label={t("inputLabel")}>{input.label}</InputField>
          <InputField label={t("inputSynthesis")}>{input.synthesis}</InputField>
          <InputField label={t("inputArticles", { n: input.articles.length })}>
            <ul className="grid gap-1">
              {input.articles.map((article, i) => (
                <li key={i}>
                  <span className="text-text-2">{article.title}</span>
                  <span className="text-text-4"> — {article.source}</span>
                </li>
              ))}
            </ul>
          </InputField>
          {input.already_kept && (
            <InputField label={t("inputAlreadyKept")}>{input.already_kept}</InputField>
          )}
        </div>
      )}

      <p className="mt-3 font-mono text-[10.5px] text-text-4">
        {decision.model} · {t("tokens", { input: decision.input_tokens, output: decision.output_tokens })}
        {" · "}
        {fmtSmartClock(decision.decided_at, locale)}
      </p>
    </section>
  );
}

/** The reason, and the passage it rests on: the passage is the article's
 *  own words, so it is quoted, not italicised with the model's. */
export function DecisionReason({ decision }: { decision: Decision }) {
  const t = useTranslations("signal.decisions.panel");
  return (
    <ModelText label={t("reason")}>
      {decision.reason}
      {decision.excerpt && (
        <blockquote className="mt-2 pl-3 border-l-2 border-border-strong not-italic text-text-3">
          {decision.excerpt}
        </blockquote>
      )}
    </ModelText>
  );
}

function InputField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-1.5 first:pt-0 last:pb-0">
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-text-4">{label}</div>
      <div className="mt-0.5 text-text-2">{children}</div>
    </div>
  );
}
