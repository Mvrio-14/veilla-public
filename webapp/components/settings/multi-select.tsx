"use client";

import * as React from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Generic multi-select dropdown used in /settings/preferences.
 *
 * UX pattern lifted from pro tools (Linear / Notion / Asana):
 *   - Trigger button shows the current state (empty = "All", 1 = the
 *     value's label, ≥ 2 = "N selected"). Click → popover.
 *   - Popover: header with "Select all" / "Clear all", optional search
 *     (auto-shown when option count > 12), scrollable checkbox list.
 *   - Grouped variant for countries-by-region: each group header is a
 *     mixed-state checkbox that toggles every option in the group at
 *     once. Indeterminate state when partial.
 *
 * Empty selection = "no filter active" (= see everything). This is the
 * standard pro convention and matches how the Watch's filter pipeline
 * interprets empty inclusion arrays in `articleMatchesAdvanced`.
 */

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectGroup {
  /** Stable key for React rendering + group identity. */
  key: string;
  /** Localized header label. */
  label: string;
  options: MultiSelectOption[];
}

type MultiSelectMode =
  | { kind: "flat"; options: MultiSelectOption[] }
  | { kind: "grouped"; groups: MultiSelectGroup[] };

interface MultiSelectProps {
  values: string[];
  onChange: (next: string[]) => void;
  /** One of `options` (flat) or `groups` (grouped by region/etc). */
  options?: MultiSelectOption[];
  groups?: MultiSelectGroup[];
  /** Forced search visibility. Defaults to auto (= true when ≥ 12 opts). */
  showSearch?: boolean;
  /** Tooltip on the trigger; describes what's being filtered. */
  ariaLabel: string;
}

export function MultiSelect({
  values,
  onChange,
  options,
  groups,
  showSearch,
  ariaLabel,
}: MultiSelectProps) {
  const t = useTranslations("multiSelect");
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const wrapRef = React.useRef<HTMLDivElement>(null);

  // Memoised: a fresh object every render would defeat the memo that
  // reads it just below.
  const mode: MultiSelectMode = React.useMemo(
    () =>
      groups
        ? { kind: "grouped", groups }
        : { kind: "flat", options: options ?? [] },
    [groups, options],
  );

  const allOptions = React.useMemo<MultiSelectOption[]>(() => {
    return mode.kind === "flat"
      ? mode.options
      : mode.groups.flatMap((g) => g.options);
  }, [mode]);

  const selectedSet = React.useMemo(() => new Set(values), [values]);

  /** Auto-show search when the option count exceeds the threshold,
   *  unless the caller forces it on/off. */
  const searchVisible = showSearch ?? allOptions.length > 12;

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Close on Escape.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /* ── Trigger label ──
   *  Always show the count (or "Tous" when empty). The actual selected
   *  values are rendered as chips below the trigger so the user keeps
   *  a stable visual of what they've picked without re-opening the
   *  popover (Salesforce / Airtable / Looker convention). */
  const triggerText: string =
    selectedSet.size === 0
      ? t("allLabel")
      : t("nSelected", { count: selectedSet.size });

  /* ── Selection helpers ── */
  const toggleOne = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(values.filter((v) => v !== value));
    } else {
      onChange([...values, value]);
    }
  };

  const selectAll = () => onChange(allOptions.map((o) => o.value));
  const clearAll = () => onChange([]);

  const allSelected = selectedSet.size === allOptions.length && allOptions.length > 0;

  /* ── Search filter (case + diacritic insensitive) ── */
  const norm = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const needle = norm(query.trim());

  const matches = (opt: MultiSelectOption) =>
    !needle || norm(opt.label).includes(needle) || norm(opt.value).includes(needle);

  /* ── Group select-all toggle (grouped mode) ──
   *  Click a region header → if every member is already in the selection,
   *  remove them all; otherwise add the missing ones. Mirrors the
   *  indeterminate-checkbox convention. */
  const toggleGroup = (group: MultiSelectGroup) => {
    const groupValues = group.options.map((o) => o.value);
    const allIn = groupValues.every((v) => selectedSet.has(v));
    if (allIn) {
      onChange(values.filter((v) => !groupValues.includes(v)));
    } else {
      const next = new Set(values);
      for (const v of groupValues) next.add(v);
      onChange(Array.from(next));
    }
  };

  /* ── Render ── */
  return (
    <div ref={wrapRef} className="relative w-full max-w-[360px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "w-full flex items-center justify-between gap-2",
          "px-3 py-2 rounded-md",
          "bg-bg-sub border border-border",
          "text-[13px] text-text-2 hover:text-text hover:bg-bg-hover",
          "transition-colors cursor-pointer outline-none",
          "focus-visible:border-text-4 focus-visible:bg-bg-elev",
        )}
      >
        <span
          className={cn(
            "truncate",
            selectedSet.size === 0 ? "text-text-3" : "text-text font-medium",
          )}
        >
          {triggerText}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.8}
          className={cn(
            "shrink-0 text-text-4 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Selected chips — read-only mirror of the current selection,
       *  with per-chip X to remove. Sits below the trigger so the user
       *  can scan / prune their picks without re-opening the popover.
       *  Hidden entirely when nothing is selected (= "Tous" state). */}
      {selectedSet.size > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {values.map((v) => {
            const opt = allOptions.find((o) => o.value === v);
            const label = opt?.label ?? v;
            return (
              <span
                key={v}
                className={cn(
                  "inline-flex items-center gap-1",
                  "pl-2 pr-1 py-0.5 rounded-full",
                  "bg-accent-soft text-accent-text",
                  "border border-accent/30",
                  "text-[11.5px] font-medium",
                  "max-w-[180px]",
                )}
                title={label}
              >
                <span className="truncate">{label}</span>
                <button
                  type="button"
                  onClick={() => onChange(values.filter((x) => x !== v))}
                  aria-label={t("removeItem", { name: label })}
                  className={cn(
                    "shrink-0 inline-flex items-center justify-center",
                    "w-4 h-4 rounded-full",
                    "hover:bg-accent/20 cursor-pointer transition-colors",
                  )}
                >
                  <X size={10} strokeWidth={2} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className={cn(
            "absolute top-full left-0 mt-1 z-50",
            "w-[320px] max-w-[calc(100vw-32px)]",
            "bg-bg-elev border border-border rounded-md shadow-lg",
            "flex flex-col",
            "max-h-[420px]",
          )}
        >
          {/* Header — select-all / clear-all */}
          <div className="flex items-center gap-3 px-3 py-2 border-b border-border shrink-0">
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected}
              className={cn(
                "text-[11.5px] font-medium",
                allSelected
                  ? "text-text-4 cursor-not-allowed"
                  : "text-accent-text hover:underline cursor-pointer",
              )}
            >
              {t("selectAll")}
            </button>
            <span className="text-text-4 text-[11px]">·</span>
            <button
              type="button"
              onClick={clearAll}
              disabled={selectedSet.size === 0}
              className={cn(
                "text-[11.5px] font-medium",
                selectedSet.size === 0
                  ? "text-text-4 cursor-not-allowed"
                  : "text-text-2 hover:text-text hover:underline cursor-pointer",
              )}
            >
              {t("clearAll")}
            </button>
            <span className="ml-auto text-[10.5px] tabular-nums text-text-4">
              {selectedSet.size} / {allOptions.length}
            </span>
          </div>

          {/* Optional search */}
          {searchVisible && (
            <div className="px-3 py-2 border-b border-border shrink-0">
              <div className="relative">
                <Search
                  size={11}
                  strokeWidth={1.8}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none"
                />
                <input
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className={cn(
                    "w-full pl-7 pr-2.5 py-1.5 rounded-md",
                    "bg-bg-sub border border-border",
                    "text-[12px] text-text placeholder:text-text-4",
                    "outline-none focus:border-text-4 focus:bg-bg-elev",
                    "transition-colors",
                  )}
                />
              </div>
            </div>
          )}

          {/* Options list */}
          <div className="flex-1 overflow-y-auto py-1">
            {mode.kind === "flat" ? (
              <FlatList
                options={mode.options.filter(matches)}
                selectedSet={selectedSet}
                onToggle={toggleOne}
                empty={t("noResults")}
              />
            ) : (
              <GroupedList
                groups={mode.groups}
                selectedSet={selectedSet}
                onToggleOne={toggleOne}
                onToggleGroup={toggleGroup}
                matches={matches}
                empty={t("noResults")}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────── Flat list ─────────── */

function FlatList({
  options,
  selectedSet,
  onToggle,
  empty,
}: {
  options: MultiSelectOption[];
  selectedSet: Set<string>;
  onToggle: (value: string) => void;
  empty: string;
}) {
  if (options.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-text-4 italic text-center">
        {empty}
      </div>
    );
  }
  return (
    <>
      {options.map((opt) => (
        <OptionRow
          key={opt.value}
          label={opt.label}
          checked={selectedSet.has(opt.value)}
          onClick={() => onToggle(opt.value)}
        />
      ))}
    </>
  );
}

/* ─────────── Grouped list ─────────── */

function GroupedList({
  groups,
  selectedSet,
  onToggleOne,
  onToggleGroup,
  matches,
  empty,
}: {
  groups: MultiSelectGroup[];
  selectedSet: Set<string>;
  onToggleOne: (value: string) => void;
  onToggleGroup: (group: MultiSelectGroup) => void;
  matches: (opt: MultiSelectOption) => boolean;
  empty: string;
}) {
  // Filter group options by search, drop empty groups.
  const visible = groups
    .map((g) => ({ ...g, options: g.options.filter(matches) }))
    .filter((g) => g.options.length > 0);

  if (visible.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] text-text-4 italic text-center">
        {empty}
      </div>
    );
  }

  return (
    <>
      {visible.map((g) => {
        const inGroup = g.options.map((o) => o.value);
        const selectedInGroup = inGroup.filter((v) => selectedSet.has(v)).length;
        const allIn = selectedInGroup === inGroup.length;
        const someIn = selectedInGroup > 0 && !allIn;

        return (
          <div key={g.key}>
            <button
              type="button"
              onClick={() => onToggleGroup(g)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5",
                "text-[11px] font-semibold uppercase tracking-[0.06em]",
                "text-text-3 hover:text-text hover:bg-bg-hover",
                "transition-colors cursor-pointer",
              )}
            >
              <CheckboxBox checked={allIn} indeterminate={someIn} />
              <span className="flex-1 text-left">{g.label}</span>
              <span className="text-[10.5px] tabular-nums text-text-4 font-normal normal-case tracking-normal">
                {selectedInGroup} / {inGroup.length}
              </span>
            </button>
            {g.options.map((opt) => (
              <OptionRow
                key={opt.value}
                label={opt.label}
                checked={selectedSet.has(opt.value)}
                onClick={() => onToggleOne(opt.value)}
                indent
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

/* ─────────── Atoms ─────────── */

function OptionRow({
  label,
  checked,
  onClick,
  indent = false,
}: {
  label: string;
  checked: boolean;
  onClick: () => void;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 py-1.5",
        indent ? "pl-7 pr-3" : "px-3",
        "text-[12.5px] text-left",
        checked ? "text-text" : "text-text-2",
        "hover:bg-bg-hover cursor-pointer transition-colors",
      )}
    >
      <CheckboxBox checked={checked} />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

function CheckboxBox({
  checked,
  indeterminate = false,
}: {
  checked: boolean;
  indeterminate?: boolean;
}) {
  const active = checked || indeterminate;
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0 inline-flex items-center justify-center",
        "w-4 h-4 rounded border transition-colors",
        active
          ? "bg-accent border-accent text-bg"
          : "bg-bg-sub border-border",
      )}
    >
      {indeterminate ? (
        <span className="block w-2 h-[2px] bg-bg rounded-sm" />
      ) : checked ? (
        <Check size={11} strokeWidth={3} />
      ) : null}
    </span>
  );
}
