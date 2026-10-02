"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ArrowLeft, ArrowRight, Pause, Play, Trash2 } from "lucide-react";
import { SourceMark } from "@/components/app/source-mark";
import { BudgetWarning } from "@/components/signal/budget-warning";
import { DecisionReason } from "@/components/signal/decision-panel";
import { Button } from "@/components/ui/button";
import { Metric } from "@/components/ui/facts";
import { ProseEditor } from "@/components/ui/prose-editor";
import { SearchInput } from "@/components/ui/search-input";
import { TabPanel, TabStrip } from "@/components/ui/tab-strip";
import { deleteWatcher, updateWatcher } from "@/lib/actions";
import { useCanWrite } from "@/lib/auth/can-write";
import { dayBucket, fmtSmartClock } from "@/lib/format";
import type { Watcher, StoryMoment } from "@/lib/signal";
import type { Monitor } from "@/lib/monitors";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

/**
 * One agent's page.
 *
 *   Kept           what it passed on, with the reason it gave: the feed
 *                  a reader of this agent would receive
 *   Configuration  what it is asked, and which monitors it reads
 *
 * Its dropped stories are not listed here: they outnumber the kept ones
 * ten to one and are only worth reading when a verdict looks wrong,
 * which is what the Decisions screen is for. Each kept story links to
 * its decision there.
 */

type Tab = "kept" | "configuration";
const TABS: Tab[] = ["kept", "configuration"];

export function AgentDetail({
  agent,
  moments,
  monitors,
}: {
  agent: Watcher;
  moments: StoryMoment[];
  monitors: Monitor[];
}) {
  const t = useTranslations("signal.agent");
  const tc = useTranslations("common");
  const [tab, setTab] = useUrlState<Tab>("tab", "kept");
  const router = useRouter();
  const canWrite = useCanWrite();
  const paused = agent.status === "paused";

  // Pending through the server re-render too, so the button does not go
  // idle while the page still shows the old status.
  const [pending, startTransition] = React.useTransition();
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const act = (action: () => Promise<unknown>, then: () => void) => {
    setFailed(false);
    startTransition(async () => {
      try {
        await action();
        then();
      } catch (err) {
        console.error("[agent] action failed", err);
        setFailed(true);
      }
    });
  };

  const kept = moments.filter((m) =>
    m.decisions.some((d) => d.watcher_id === agent.id && d.verdict === "kept"),
  );

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <header className="shrink-0 px-7 pt-6">
        <Link
          href="/signal/agents"
          className="inline-flex items-center gap-1.5 text-[12px] text-text-3 hover:text-text transition-colors"
        >
          <ArrowLeft size={13} strokeWidth={1.8} aria-hidden />
          {tc("back")}
        </Link>

        <div className="flex items-start gap-4 mt-4">
          <div className="min-w-0">
            <h1 className="text-[28px] font-normal tracking-[-0.02em] leading-tight truncate">
              {agent.name}
            </h1>
            <p className="mt-1 text-[12px] text-text-3">
              {paused ? t("paused") : t("active")}
            </p>
          </div>
          <div className="flex-1" />
          {failed && (
            <span role="alert" className="self-center text-[12px] text-hot">
              {t("failed")}
            </span>
          )}
          {canWrite && (
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="surface"
                size="lg"
                className="gap-2"
                disabled={pending}
                onClick={() =>
                  act(
                    () => updateWatcher(agent.id, { status: paused ? "active" : "paused" }),
                    () => router.refresh(),
                  )
                }
              >
                {paused ? (
                  <Play size={13} fill="currentColor" stroke="none" aria-hidden />
                ) : (
                  <Pause size={13} fill="currentColor" stroke="none" aria-hidden />
                )}
                {paused ? t("resume") : t("pause")}
              </Button>
              {/* Two clicks, the second on a button that says what it does:
               *  deleting an agent deletes its verdicts with it. */}
              <Button
                variant="danger"
                size="lg"
                className="gap-2"
                disabled={pending}
                onBlur={() => setConfirmingDelete(false)}
                onClick={() =>
                  confirmingDelete
                    ? act(
                        () => deleteWatcher(agent.id),
                        () => {
                          router.push("/signal/agents");
                          router.refresh();
                        },
                      )
                    : setConfirmingDelete(true)
                }
              >
                <Trash2 size={13} strokeWidth={1.8} aria-hidden />
                {confirmingDelete ? t("confirmDelete") : t("delete")}
              </Button>
            </div>
          )}
        </div>

        <div className="mt-4 empty:hidden">
          <BudgetWarning watcher={agent} />
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
          {tab === "kept" && <Kept agent={agent} moments={kept} />}
          {tab === "configuration" && <Configuration agent={agent} monitors={monitors} />}
        </TabPanel>
      </div>
    </main>
  );
}

function Kept({ agent, moments }: { agent: Watcher; moments: StoryMoment[] }) {
  const t = useTranslations("signal.agent");
  const locale = useLocale();
  const judged = agent.kept_7d + agent.dropped_7d;

  const days: { key: string; label: string; moments: StoryMoment[] }[] = [];
  for (const moment of moments) {
    const { key, label } = dayBucket(moment.at, locale);
    const last = days[days.length - 1];
    if (last?.key === key) last.moments.push(moment);
    else days.push({ key, label, moments: [moment] });
  }

  return (
    <>
      <div className="grid gap-2 grid-cols-3">
        <Metric label={t("kept7d")} value={agent.kept_7d} />
        <Metric label={t("dropped7d")} value={agent.dropped_7d} />
        <Metric
          label={t("keepRate")}
          value={
            judged
              ? (agent.kept_7d / judged).toLocaleString(locale, {
                  style: "percent",
                  maximumFractionDigits: 1,
                })
              : "—"
          }
        />
      </div>

      {moments.length === 0 ? (
        <p className="mt-8 text-[12.5px] text-text-4">{t("noneKept")}</p>
      ) : (
        days.map((day) => (
          <section key={day.key} className="mt-8">
            <h2 className="mb-2.5 text-[12px] font-semibold text-text-3">{day.label}</h2>
            <ul className="grid gap-2">
              {day.moments.map((moment) => {
                const decision = moment.decisions.find((d) => d.watcher_id === agent.id)!;
                return (
                  <li
                    key={moment.id}
                    className="rounded-lg border border-border bg-bg-elev px-4 py-3.5"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 text-[14px] font-medium leading-snug text-text">
                        {moment.label}
                      </span>
                      <span className="flex-1" />
                      <span className="shrink-0 text-[11.5px] text-text-4">
                        {fmtSmartClock(moment.at, locale)}
                      </span>
                    </div>
                    <div className="mt-2.5">
                      <DecisionReason decision={decision} />
                    </div>
                    <Link
                      href={`/signal/decisions?moment=${moment.id}`}
                      className="inline-flex items-center gap-1 mt-2.5 text-[11.5px] text-text-3 hover:text-text transition-colors"
                    >
                      {t("seeDecision")}
                      <ArrowRight size={11} strokeWidth={1.8} aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

function Configuration({ agent, monitors }: { agent: Watcher; monitors: Monitor[] }) {
  const t = useTranslations("signal.agent.config");
  const router = useRouter();
  const canWrite = useCanWrite();
  return (
    <div className="grid gap-10">
      <ProseEditor
        value={agent.request}
        onSave={async (request) => {
          await updateWatcher(agent.id, { request });
          router.refresh();
        }}
        label={t("request")}
        hint={t("requestHint")}
        versionNote={t("requestNote")}
        rows={6}
        readOnly={!canWrite}
      />
      <ScopeEditor
        initial={agent.monitor_ids}
        monitors={monitors}
        readOnly={!canWrite}
        onSave={(monitorIds) => updateWatcher(agent.id, { monitor_ids: monitorIds })}
      />
    </div>
  );
}

/**
 * Which monitors the agent reads: all of them, or a chosen set.
 *
 * "All" is a mode rather than every box ticked: a monitor followed later
 * joins an agent that reads everything, and would silently stay out of
 * one whose every box happened to be ticked.
 *
 * Built for a hundred monitors and more: a search over the list, the
 * chosen ones first, and a count that stays visible.
 */
function ScopeEditor({
  initial,
  monitors,
  readOnly,
  onSave,
}: {
  initial: number[];
  monitors: Monitor[];
  readOnly: boolean;
  /** An empty list saves "all monitors". */
  onSave: (monitorIds: number[]) => Promise<unknown>;
}) {
  const t = useTranslations("signal.agent.config");
  const tp = useTranslations("prose");
  const [all, setAll] = React.useState(initial.length === 0);
  const [chosen, setChosen] = React.useState<Set<number>>(() => new Set(initial));
  const [query, setQuery] = React.useState("");
  const [saved, setSaved] = React.useState({ all: initial.length === 0, ids: initial });
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const dirty =
    all !== saved.all ||
    (!all && (chosen.size !== saved.ids.length || saved.ids.some((id) => !chosen.has(id))));

  const listed = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return monitors
      .filter((s) => !q || s.name.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(saved.ids.includes(b.id)) - Number(saved.ids.includes(a.id)) ||
          a.name.localeCompare(b.name),
      );
  }, [monitors, query, saved.ids]);

  const toggle = (id: number) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setFailed(false);
    try {
      await onSave(all ? [] : [...chosen]);
      setSaved({ all, ids: all ? [] : [...chosen] });
    } catch (err) {
      // The selection stays on screen, as a draft does in the editor.
      console.error("[agent] scope save failed", err);
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium text-text">{t("scope")}</h2>
        {dirty && <span className="text-[11.5px] text-text-4">{tp("unsaved")}</span>}
      </div>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-3">{t("scopeHint")}</p>

      <div role="radiogroup" className="grid gap-1.5 mt-3">
        {([true, false] as const).map((value) => (
          <label key={String(value)} className="flex items-center gap-2.5 text-[13px] cursor-pointer">
            <input
              type="radio"
              name="scope"
              checked={all === value}
              onChange={() => setAll(value)}
              disabled={readOnly}
              className="accent-[var(--text)]"
            />
            {value ? t("scopeAll") : t("scopeSome", { n: chosen.size })}
          </label>
        ))}
      </div>

      {!all && (
        <div className="mt-3 rounded-lg border border-border bg-bg-elev">
          <div className="p-2 border-b border-border">
            <SearchInput grow value={query} onChange={setQuery} placeholder={t("scopeSearch")} />
          </div>
          <ul className="max-h-[320px] overflow-y-auto p-1">
            {listed.map((monitor) => (
              <li key={monitor.id}>
                <label
                  className={cn(
                    "flex items-center gap-2.5 px-2 py-1.5 rounded-md cursor-pointer",
                    "text-[12.5px] hover:bg-bg-hover",
                    chosen.has(monitor.id) ? "text-text" : "text-text-2",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(monitor.id)}
                    onChange={() => toggle(monitor.id)}
                    disabled={readOnly}
                    className="accent-[var(--text)]"
                  />
                  <SourceMark url={monitor.site_url} name={monitor.name} size={18} />
                  <span className="truncate">{monitor.name}</span>
                </label>
              </li>
            ))}
            {listed.length === 0 && (
              <li className="px-2 py-3 text-[12px] text-text-4">{t("scopeNoMatch")}</li>
            )}
          </ul>
        </div>
      )}

      {!readOnly && (
        <div className="flex items-center gap-3 mt-3">
          {/* An empty selection would read as "all": not saved as such. */}
          <Button
            variant="solid"
            size="lg"
            onClick={save}
            disabled={!dirty || saving || (!all && chosen.size === 0)}
          >
            {saving ? tp("saving") : tp("save")}
          </Button>
          {failed && (
            <span role="alert" className="text-[12px] text-hot">
              {tp("failed")}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
