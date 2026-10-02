"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { SourceMark } from "@/components/app/source-mark";
import { Fact, Facts, Metric } from "@/components/ui/facts";
import { TabPanel, TabStrip } from "@/components/ui/tab-strip";
import { HealthPill, TemplateLabel } from "@/components/monitors/monitor-bits";
import { countryLabel, fmtAbsolute, fmtSmartClock, langLabel } from "@/lib/format";
import { healthOf, type Monitor, type MonitorItem, type MonitorRun } from "@/lib/monitors";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

/**
 * One monitor's page, three tabs each answering one question:
 *
 *   Overview       is it alive, and what has it brought lately
 *   Configuration  what exactly is fetched
 *   Logs           why did it break — every fetch of the last day
 *
 * The tab lives in the URL, so a link can open straight on the logs of
 * a failing monitor.
 */

type Tab = "overview" | "configuration" | "logs";
const TABS: Tab[] = ["overview", "configuration", "logs"];

export function MonitorDetail({
  monitor,
  runs,
  items,
}: {
  monitor: Monitor;
  runs: MonitorRun[];
  items: MonitorItem[];
}) {
  const t = useTranslations("monitors.detail");
  const tc = useTranslations("common");
  const [tab, setTab] = useUrlState<Tab>("tab", "overview");
  const health = healthOf(monitor);

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <header className="shrink-0 px-7 pt-6">
        <Link
          href="/monitors"
          className="inline-flex items-center gap-1.5 text-[12px] text-text-3 hover:text-text transition-colors"
        >
          <ArrowLeft size={13} strokeWidth={1.8} aria-hidden />
          {tc("back")}
        </Link>

        <div className="flex items-start gap-3.5 mt-4">
          <SourceMark url={monitor.site_url} name={monitor.name} size={36} className="mt-1" />
          <div className="min-w-0">
            <div className="text-[11.5px] text-text-3">
              <TemplateLabel template={monitor.template} />
            </div>
            <h1 className="mt-1 text-[28px] font-normal tracking-[-0.02em] leading-tight truncate">
              {monitor.name}
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-3">
          <HealthPill health={health} />
          {health !== "ok" && monitor.last_error && (
            <span className="text-[12px] text-hot-text truncate">{monitor.last_error}</span>
          )}
        </div>

        <TabStrip
          tabs={TABS.map((key) => ({ key, label: t(`tabs.${key}`) }))}
          value={tab}
          onChange={setTab}
          label={t("tabs.label")}
          className="mt-5"
        />
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6">
        <TabPanel tabKey={tab}>
          {tab === "overview" && <Overview monitor={monitor} runs={runs} items={items} />}
          {tab === "configuration" && <Configuration monitor={monitor} />}
          {tab === "logs" && <Logs runs={runs} />}
        </TabPanel>
      </div>
    </main>
  );
}

function Overview({
  monitor,
  runs,
  items,
}: {
  monitor: Monitor;
  runs: MonitorRun[];
  items: MonitorItem[];
}) {
  const t = useTranslations("monitors.detail.overview");
  const locale = useLocale();
  const failed = runs.filter((r) => r.outcome === "failed").length;
  const durations = runs.map((r) => r.duration_ms).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor(durations.length / 2)] : null;

  return (
    <>
      <div className="grid gap-2 grid-cols-2 xl:grid-cols-4">
        <Metric label={t("items7d")} value={monitor.items_7d} />
        <Metric label={t("runs24h")} value={runs.length} />
        <Metric
          label={t("successRate")}
          value={runs.length ? `${Math.round(((runs.length - failed) / runs.length) * 100)} %` : "—"}
          note={failed ? t("failedRuns", { n: failed }) : undefined}
        />
        <Metric label={t("medianDuration")} value={median === null ? "—" : formatDuration(median)} />
      </div>

      <div className="mt-6">
        <Facts>
          <Fact label={t("lastSuccess")}>
            {monitor.last_success_at ? fmtAbsolute(monitor.last_success_at, locale) : t("never")}
          </Fact>
          <Fact label={t("lastFailure")}>
            {monitor.last_failure_at ? fmtAbsolute(monitor.last_failure_at, locale) : t("never")}
          </Fact>
          <Fact label={t("consecutiveFailures")}>{monitor.consecutive_failures}</Fact>
        </Facts>
      </div>

      <h2 className="mt-8 mb-2.5 text-[13px] font-semibold">{t("latestItems")}</h2>
      {items.length === 0 ? (
        <p className="text-[12.5px] text-text-4">{t("noItems")}</p>
      ) : (
        <ul className="rounded-lg border border-border bg-bg-elev divide-y divide-border">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline gap-4 px-4 py-2.5">
              <span className="w-[92px] shrink-0 text-[11.5px] text-text-4">
                {fmtSmartClock(item.published_at, locale)}
              </span>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 truncate text-[13px] text-text hover:underline underline-offset-2"
              >
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Configuration({ monitor }: { monitor: Monitor }) {
  const t = useTranslations("monitors.detail.config");
  const locale = useLocale();
  return (
    <Facts>
      <Fact label={t("template")}>
        <TemplateLabel template={monitor.template} />
      </Fact>
      {monitor.query && <Fact label={t("query")}>{monitor.query}</Fact>}
      <Fact label={t("url")}>
        <a
          href={monitor.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-accent-text hover:underline underline-offset-2 break-all"
        >
          {monitor.url}
          <ExternalLink size={11} strokeWidth={1.8} aria-hidden className="shrink-0" />
        </a>
      </Fact>
      <Fact label={t("lang")}>{langLabel(monitor.lang, locale) || "—"}</Fact>
      <Fact label={t("country")}>{monitor.country ? countryLabel(monitor.country, locale) : "—"}</Fact>
      <Fact label={t("attribution")}>
        {monitor.template === "google_news" ? t("perArticle") : t("publisher")}
      </Fact>
    </Facts>
  );
}

const OUTCOME_STYLES: Record<MonitorRun["outcome"], string> = {
  ok: "text-good",
  not_modified: "text-text-3",
  failed: "text-hot-text",
};

function Logs({ runs }: { runs: MonitorRun[] }) {
  const t = useTranslations("monitors.detail.logs");
  const locale = useLocale();
  if (runs.length === 0) return <p className="text-[12.5px] text-text-4">{t("empty")}</p>;

  const columns = "grid grid-cols-[120px_110px_80px_minmax(0,1fr)] gap-x-4";
  return (
    <div className="rounded-lg border border-border bg-bg-elev">
      <div className={cn(columns, "px-4 py-2 border-b border-border text-[11px] text-text-3")}>
        <span>{t("when")}</span>
        <span>{t("outcome")}</span>
        <span className="text-right">{t("duration")}</span>
        <span>{t("result")}</span>
      </div>
      <ul className="divide-y divide-border">
        {runs.map((run) => (
          <li key={run.id} className={cn(columns, "px-4 py-2 text-[12px] items-baseline")}>
            <span className="text-text-3">{fmtSmartClock(run.started_at, locale)}</span>
            <span className={OUTCOME_STYLES[run.outcome]}>{t(`outcomes.${run.outcome}`)}</span>
            <span className="text-right font-mono text-[11.5px] text-text-3">
              {formatDuration(run.duration_ms)}
            </span>
            <span className="min-w-0 truncate text-text-2">
              {run.outcome === "failed"
                ? run.error
                : run.outcome === "ok"
                  ? t("items", { seen: run.items_seen, fresh: run.items_new })
                  : t("unchanged")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
