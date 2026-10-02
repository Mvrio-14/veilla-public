"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Group } from "lucide-react";
import { SourceMark } from "@/components/app/source-mark";
import { FilterMenu, type FilterField } from "@/components/ui/filter-menu";
import { Menu, MenuHeading, MenuItem } from "@/components/ui/menu";
import { SearchInput } from "@/components/ui/search-input";
import { HealthPill, TemplateLabel } from "@/components/monitors/monitor-bits";
import { fmtSmartClock, langLabel } from "@/lib/format";
import {
  HEALTH_ORDER,
  healthOf,
  type Monitor,
  type MonitorHealth,
  type MonitorTemplate,
} from "@/lib/monitors";
import { useUrlState } from "@/lib/use-url-state";
import { cn } from "@/lib/utils";

/**
 * The Monitors screen — what the reader follows, and whether it works.
 * Shared by Desk and Signal: both read from the same monitors.
 *
 * ## Rows, not cards
 *
 * A reader follows a hundred monitors, not a dozen, and a grid of cards
 * turns a hundred into a long scroll where no two columns line up. One
 * row per monitor, with the same columns in the same place, reads like a
 * table: the eye runs down "Articles, 7 d" and finds the one at zero.
 * The list is virtualised for the same reason.
 *
 * ## What comes first
 *
 * Failing monitors, then degraded ones, then the rest by name. A list
 * sorted by name alone buries the one monitor that stopped answering.
 *
 * Search, filters and grouping live in the URL: a filtered list is a
 * link, survives a refresh, and the back button undoes a filter.
 * Filtering runs in the browser, which holds at this size; past a few
 * thousand rows it belongs to the API.
 */

type GroupKey = "none" | "health" | "template" | "lang";
type Facet = "health" | "template" | "lang";

const HEADER_HEIGHT = 44;
const ROW_HEIGHT = 52;

/** Name · Type · Language · Articles, 7 d · Last article · Health */
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_120px_96px_88px_112px_96px] items-center gap-x-4";

type Line =
  | { type: "header"; key: string; label: string; count: number }
  | { type: "row"; key: string; monitor: Monitor };

export function MonitorsView({ monitors }: { monitors: Monitor[] }) {
  const t = useTranslations("monitors");
  const tf = useTranslations("filters");
  const locale = useLocale();

  // Search replaces: twelve keystrokes are one intent, not twelve steps
  // for the back button. Every other control pushes.
  const [query, setQuery] = useUrlState<string>("q", "", { history: "replace" });
  const [health, setHealth] = useUrlState<string[]>("health", []);
  const [template, setTemplate] = useUrlState<string[]>("template", []);
  const [lang, setLang] = useUrlState<string[]>("lang", []);
  const [group, setGroup] = useUrlState<GroupKey>("group", "none");

  const facetOf = React.useCallback(
    (s: Monitor, facet: Facet): string =>
      facet === "health" ? healthOf(s) : facet === "template" ? s.template : (s.lang ?? ""),
    [],
  );
  const labelOf = React.useCallback(
    (facet: Facet, value: string): string =>
      facet === "health"
        ? t(`health.${value as MonitorHealth}`)
        : facet === "template"
          ? t(`template.${value as MonitorTemplate}`)
          : langLabel(value, locale) || t("noLang"),
    [t, locale],
  );

  // Search applies before the facets, so the count beside each facet
  // value describes the searched subset rather than promising rows the
  // search excludes.
  const searched = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return monitors;
    return monitors.filter((s) =>
      `${s.name} ${s.url} ${s.query ?? ""}`.toLowerCase().includes(q),
    );
  }, [monitors, query]);

  const selected: Record<Facet, string[]> = React.useMemo(
    () => ({ health, template, lang }),
    [health, template, lang],
  );

  /** Rows matching every facet but `except`: the counts of a facet's
   *  values say what clicking one of them would give. */
  const matching = React.useCallback(
    (rows: Monitor[], except?: Facet) =>
      rows.filter((s) =>
        (Object.keys(selected) as Facet[]).every(
          (facet) =>
            facet === except ||
            !selected[facet].length ||
            selected[facet].includes(facetOf(s, facet)),
        ),
      ),
    [selected, facetOf],
  );

  const visible = React.useMemo(
    () =>
      matching(searched).sort(
        (a, b) =>
          HEALTH_ORDER[healthOf(a)] - HEALTH_ORDER[healthOf(b)] ||
          a.name.localeCompare(b.name, locale),
      ),
    [searched, matching, locale],
  );

  const fields: FilterField[] = React.useMemo(() => {
    const setters: Record<Facet, (next: string[]) => void> = {
      health: setHealth,
      template: setTemplate,
      lang: setLang,
    };
    const facetLabels: Record<Facet, string> = {
      health: t("columns.health"),
      template: t("columns.template"),
      lang: t("columns.lang"),
    };
    return (["health", "template", "lang"] as Facet[]).map((facet) => {
      const pool = matching(searched, facet);
      const values = [...new Set(searched.map((s) => facetOf(s, facet)))];
      return {
        key: facet,
        label: facetLabels[facet],
        value: selected[facet],
        onChange: setters[facet],
        options: values
          .map((value) => ({
            value,
            label: labelOf(facet, value),
            count: pool.filter((s) => facetOf(s, facet) === value).length,
          }))
          .sort((a, b) =>
            facet === "health"
              ? HEALTH_ORDER[a.value as MonitorHealth] - HEALTH_ORDER[b.value as MonitorHealth]
              : b.count - a.count,
          ),
      };
    });
  }, [searched, selected, matching, facetOf, labelOf, setHealth, setTemplate, setLang, t]);

  const lines: Line[] = React.useMemo(() => {
    if (group === "none") {
      return visible.map((monitor) => ({ type: "row", key: `s${monitor.id}`, monitor }));
    }
    const buckets = new Map<string, Monitor[]>();
    for (const s of visible) {
      const value = facetOf(s, group);
      if (!buckets.has(value)) buckets.set(value, []);
      buckets.get(value)!.push(s);
    }
    // `visible` is already in health order, so the buckets are too.
    const ordered = [...buckets.entries()];
    if (group !== "health") ordered.sort(([, a], [, b]) => b.length - a.length);
    return ordered.flatMap(([value, rows]): Line[] => [
      { type: "header", key: `h${value}`, label: labelOf(group, value), count: rows.length },
      ...rows.map((monitor): Line => ({ type: "row", key: `s${monitor.id}`, monitor })),
    ]);
  }, [visible, group, facetOf, labelOf]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (lines[i].type === "header" ? HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey: (i) => lines[i].key,
    overscan: 10,
  });

  const nToCheck = monitors.filter((s) => healthOf(s) !== "ok").length;

  const resetFilters = () => {
    // One intent, one history entry: three setters would each read a
    // stale `location.search` and push three times.
    const params = new URLSearchParams(window.location.search);
    ["health", "template", "lang"].forEach((k) => params.delete(k));
    const qs = params.toString();
    window.history.pushState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  };

  const groupOptions: { key: GroupKey; label: string }[] = [
    { key: "health", label: t("columns.health") },
    { key: "template", label: t("columns.template") },
    { key: "lang", label: t("columns.lang") },
  ];

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <div className="shrink-0 px-7 pt-8">
        <h1 className="text-[28px] font-normal tracking-[-0.02em] leading-tight">{t("title")}</h1>
        <p className="mt-1 text-[12px] text-text-3">
          {t("count", { n: monitors.length })}
          {nToCheck > 0 && (
            <span className="text-priority-text">
              {" · "}
              {t("toCheck", { n: nToCheck })}
            </span>
          )}
        </p>

        <div className="flex items-center gap-2.5 mt-5 pb-4">
          <SearchInput grow value={query} onChange={setQuery} placeholder={t("search")} />
          <FilterMenu fields={fields} onReset={resetFilters} />
          <Menu
            align="end"
            closeOnSelect
            label={
              <>
                <Group size={13} strokeWidth={1.8} aria-hidden />
                {group === "none"
                  ? tf("noGrouping")
                  : groupOptions.find((o) => o.key === group)?.label}
              </>
            }
          >
            <MenuHeading>{tf("groupBy")}</MenuHeading>
            {groupOptions.map((option) => (
              <MenuItem
                key={option.key}
                selected={group === option.key}
                onSelect={() => setGroup(option.key)}
              >
                {option.label}
              </MenuItem>
            ))}
            <MenuItem selected={group === "none"} onSelect={() => setGroup("none")}>
              {tf("noGrouping")}
            </MenuItem>
          </Menu>
        </div>

        <div
          className={cn(
            COLUMNS,
            "h-8 px-3 border-y border-border text-[11px] text-text-3 whitespace-nowrap",
          )}
        >
          <span>{t("columns.name")}</span>
          <span>{t("columns.template")}</span>
          <span>{t("columns.lang")}</span>
          <span className="text-right">{t("columns.items7d")}</span>
          <span>{t("columns.lastItem")}</span>
          <span>{t("columns.health")}</span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-7 pb-10">
        {lines.length === 0 ? (
          <p className="pt-10 text-center text-[12px] text-text-4">
            {monitors.length === 0 ? t("noneYet") : t("empty")}
          </p>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = lines[item.index];
              return (
                <div
                  key={item.key}
                  className="absolute inset-x-0 top-0"
                  style={{ height: item.size, transform: `translateY(${item.start}px)` }}
                >
                  {line.type === "header" ? (
                    <div className="h-full flex items-end gap-2 px-3 pb-2 border-b border-border">
                      <h2 className="text-[13px] font-semibold tracking-[-0.01em]">{line.label}</h2>
                      <span className="font-mono text-[11px] text-text-4">{line.count}</span>
                    </div>
                  ) : (
                    <MonitorRow monitor={line.monitor} locale={locale} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function MonitorRow({ monitor, locale }: { monitor: Monitor; locale: string }) {
  const t = useTranslations("monitors");
  const health = healthOf(monitor);
  return (
    <Link
      href={`/monitors/${monitor.id}`}
      className={cn(
        COLUMNS,
        "h-full px-3 border-b border-border text-[12.5px] whitespace-nowrap",
        "hover:bg-bg-hover transition-colors duration-100",
      )}
    >
      <span className="flex items-center gap-3 min-w-0">
        <SourceMark url={monitor.site_url} name={monitor.name} size={24} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-text">{monitor.name}</span>
          {health !== "ok" && monitor.last_error ? (
            <span className="block truncate text-[11.5px] text-hot-text">{monitor.last_error}</span>
          ) : (
            <span className="block truncate text-[11.5px] text-text-4">
              {monitor.query ?? monitor.url.replace(/^https?:\/\//, "")}
            </span>
          )}
        </span>
      </span>
      <span className="min-w-0 text-text-3">
        <TemplateLabel template={monitor.template} />
      </span>
      <span className="truncate text-text-3">{langLabel(monitor.lang, locale) || "—"}</span>
      <span
        className={cn(
          "text-right font-mono text-[12px]",
          monitor.items_7d ? "text-text-2" : "text-text-4",
        )}
      >
        {monitor.items_7d}
      </span>
      <span className="truncate text-text-3">
        {monitor.last_item_at ? fmtSmartClock(monitor.last_item_at, locale) : t("never")}
      </span>
      <span>
        <HealthPill health={health} />
      </span>
    </Link>
  );
}
