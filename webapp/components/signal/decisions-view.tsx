"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { DecisionPanel } from "@/components/signal/decision-panel";
import { VerdictMark, type Mark } from "@/components/signal/verdict-mark";
import { LevelHeading, LevelRow } from "@/components/app/level-nav";
import { SidebarLevel } from "@/components/app/sidebar-level";
import { SearchInput } from "@/components/ui/search-input";
import { dayBucket, fmtSmartClock } from "@/lib/format";
import type { Watcher, StoryMoment } from "@/lib/signal";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

/**
 * The Decisions screen — every story the agents looked at, and what each
 * of them decided. It is where a verdict that looks wrong is checked.
 *
 * ## One row per story moment, not per decision
 *
 * The question it answers is "why did this story reach me, or not", and
 * that is asked about a story. A row per decision would list the same
 * story once per agent and scatter its verdicts; a row per moment puts
 * them side by side, which is also how a disagreement between two agents
 * shows.
 *
 * ## Not judged is a verdict too
 *
 * An agent that did not judge a story, because the story was outside its
 * monitors or its daily budget was spent, is listed as such. Leaving it
 * out would make "dropped" and "never looked" look the same, and they
 * call for opposite fixes: one is the request, the other the scope.
 *
 * Selecting a row opens the panel with everything each agent was given
 * and answered. The selection is in the URL, so "look at this decision"
 * is a link.
 *
 * ## Filters in the sidebar
 *
 * As on the Watch, the filters are the screen's own navigation: one
 * verdict and one agent at most, each with the count it would give.
 * One of each is what a check needs ("what did this agent drop"), and a
 * list of rows shows every count at once where a menu hides them.
 */

type Entry = { agentId: number; mark: Mark };

function entriesOf(moment: StoryMoment): Entry[] {
  return [
    ...moment.decisions.map((d) => ({ agentId: d.watcher_id, mark: d.verdict as Mark })),
    ...moment.not_judged.map((n) => ({ agentId: n.watcher_id, mark: "not_judged" as Mark })),
  ];
}

const MARK_ORDER: Mark[] = ["kept", "dropped", "not_judged"];

export function DecisionsView({ moments, agents }: { moments: StoryMoment[]; agents: Watcher[] }) {
  const t = useTranslations("signal.decisions");
  const tv = useTranslations("signal.verdicts");
  const locale = useLocale();

  const [query, setQuery] = useUrlState<string>("q", "", { history: "replace" });
  const [agentFilter, setAgentFilter] = useUrlState<string>("agent", "");
  const [markFilter, setMarkFilter] = useUrlState<string>("verdict", "");
  const [selectedParam, setSelected] = useUrlState<string>("moment", "");
  const selectedId = Number(selectedParam) || null;

  const agentName = React.useCallback(
    (id: number) => agents.find((a) => a.id === id)?.name ?? `#${id}`,
    [agents],
  );

  const searched = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return moments;
    return moments.filter((m) =>
      [m.label, ...m.articles.map((a) => `${a.title} ${a.source}`)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [moments, query]);

  /** A moment matches when one of its entries satisfies both filters at
   *  once: "kept by agent A" must not match a story A dropped and B kept. */
  const matches = React.useCallback(
    (moment: StoryMoment, agent: string, mark: string) =>
      (!agent && !mark) ||
      entriesOf(moment).some(
        (e) => (!agent || String(e.agentId) === agent) && (!mark || e.mark === mark),
      ),
    [],
  );

  const visible = React.useMemo(
    () => searched.filter((m) => matches(m, agentFilter, markFilter)),
    [searched, matches, agentFilter, markFilter],
  );

  const days = React.useMemo(() => {
    const out: { key: string; label: string; moments: StoryMoment[] }[] = [];
    for (const moment of visible) {
      const { key, label } = dayBucket(moment.at, locale);
      const last = out[out.length - 1];
      if (last?.key === key) last.moments.push(moment);
      else out.push({ key, label, moments: [moment] });
    }
    return out;
  }, [visible, locale]);

  const selected = moments.find((m) => m.id === selectedId) ?? null;

  const nKept = moments.filter((m) => m.decisions.some((d) => d.verdict === "kept")).length;

  return (
    <div className="flex-1 min-w-0 flex">
      <SidebarLevel>
        <div className="flex flex-col pt-1">
          <LevelRow
            label={t("all")}
            count={searched.length}
            active={!agentFilter && !markFilter}
            onSelect={() => {
              // Both at once, one history entry: two setters would each
              // read a stale `location.search`.
              const params = new URLSearchParams(window.location.search);
              params.delete("agent");
              params.delete("verdict");
              const qs = params.toString();
              window.history.pushState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
            }}
          />
          <LevelHeading>{t("filterVerdict")}</LevelHeading>
          {MARK_ORDER.map((mark) => (
            <LevelRow
              key={mark}
              label={tv(mark)}
              count={searched.filter((m) => matches(m, agentFilter, mark)).length}
              active={markFilter === mark}
              onSelect={() => setMarkFilter(markFilter === mark ? "" : mark)}
            />
          ))}
          <LevelHeading>{t("filterAgent")}</LevelHeading>
          {agents.map((agent) => {
            const id = String(agent.id);
            return (
              <LevelRow
                key={id}
                label={agent.name}
                count={searched.filter((m) => matches(m, id, markFilter)).length}
                active={agentFilter === id}
                onSelect={() => setAgentFilter(agentFilter === id ? "" : id)}
              />
            );
          })}
        </div>
      </SidebarLevel>

      <main className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 px-7 pt-8">
          <h1 className="text-[28px] font-normal tracking-[-0.02em] leading-tight">{t("title")}</h1>
          <p className="mt-1 text-[12px] text-text-3">
            {t("summary", { n: moments.length, kept: nKept })}
          </p>
          <div className="flex items-center gap-2.5 mt-5 pb-4 border-b border-border">
            <SearchInput grow value={query} onChange={setQuery} placeholder={t("search")} />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-7 pt-4 pb-10">
          {visible.length === 0 ? (
            <p className="pt-10 text-center text-[12px] text-text-4">
              {moments.length === 0 ? t("noneYet") : t("empty")}
            </p>
          ) : (
            days.map((day) => (
              <section key={day.key} className="mb-6 last:mb-0">
                <h2 className="sticky top-0 z-10 py-2 bg-bg text-[12px] font-semibold text-text-3">
                  {day.label}
                </h2>
                <ul className="grid gap-1">
                  {day.moments.map((moment) => (
                    <li key={moment.id}>
                      <MomentRow
                        moment={moment}
                        agentName={agentName}
                        locale={locale}
                        selected={moment.id === selectedId}
                        onSelect={() =>
                          setSelected(moment.id === selectedId ? "" : String(moment.id))
                        }
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </main>

      {selected && (
        // Keyed by moment: what was unfolded for one story stays with it.
        <DecisionPanel
          key={selected.id}
          moment={selected}
          agentName={agentName}
          onClose={() => setSelected("")}
        />
      )}
    </div>
  );
}

function MomentRow({
  moment,
  agentName,
  locale,
  selected,
  onSelect,
}: {
  moment: StoryMoment;
  agentName: (id: number) => string;
  locale: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useTranslations("signal.decisions");
  const sources = [...new Set(moment.articles.map((a) => a.source).filter(Boolean))];
  const entries = entriesOf(moment).sort(
    (a, b) => MARK_ORDER.indexOf(a.mark) - MARK_ORDER.indexOf(b.mark),
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "w-full text-left grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5",
        "rounded-lg border px-4 py-3 cursor-pointer transition-colors duration-100",
        selected
          ? "border-border-strong bg-bg-active"
          : "border-transparent hover:bg-bg-hover",
      )}
    >
      <span className="min-w-0 text-[13.5px] font-medium leading-snug text-text">
        {moment.label}
      </span>
      <span className="text-[11.5px] text-text-4 whitespace-nowrap">
        {fmtSmartClock(moment.at, locale)}
      </span>
      <span className="col-span-full min-w-0 truncate text-[11.5px] text-text-3">
        {t("newArticles", { n: moment.articles.length })}
        {sources.length > 0 && ` · ${sources.slice(0, 3).join(", ")}`}
        {sources.length > 3 && ` +${sources.length - 3}`}
      </span>
      {entries.length > 0 && (
        <span className="col-span-full flex flex-wrap gap-1.5 mt-0.5">
          {entries.map((e) => (
            <VerdictMark key={e.agentId} mark={e.mark} agent={agentName(e.agentId)} />
          ))}
        </span>
      )}
    </button>
  );
}
