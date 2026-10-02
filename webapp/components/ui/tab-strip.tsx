"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A tab strip that keeps the promises the `tablist` role makes.
 *
 * The markup is trivial; the keyboard behaviour is not, which is why the
 * detail pages share this rather than each writing their own. Two rules
 * do the work:
 *
 * **Roving tabindex** — the strip is ONE tab stop, not one per tab. With
 * four separate stops, leaving the header costs a keyboard user four
 * presses of Tab. This is what the role means: Tab moves between
 * widgets, arrows move within one.
 *
 * **Explicit focus move** — since only the selected tab is focusable,
 * selecting a new one leaves focus on an element that just became
 * unreachable. The browser won't fix that; we do.
 */
export type TabDef<K extends string> = { key: K; label: string };

export function TabStrip<K extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: readonly TabDef<K>[];
  value: K;
  onChange: (next: K) => void;
  /** Names the strip for screen readers — "Source sections". */
  label: string;
  className?: string;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    let nextIndex: number | null = null;

    if (step !== 0) {
      const current = tabs.findIndex((tab) => tab.key === value);
      nextIndex = (current + step + tabs.length) % tabs.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;

    e.preventDefault();
    const nextKey = tabs[nextIndex].key;
    onChange(nextKey);
    document.getElementById(`tab-${nextKey}`)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-1 border-b border-border", className)}
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          id={`tab-${tab.key}`}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          aria-controls={`panel-${tab.key}`}
          tabIndex={value === tab.key ? 0 : -1}
          onClick={() => onChange(tab.key)}
          className={cn(
            "relative px-3 py-2 text-[13px] cursor-pointer transition-colors",
            "after:absolute after:left-0 after:right-0 after:-bottom-px after:h-px",
            value === tab.key
              ? "text-text font-medium after:bg-text"
              : "text-text-3 hover:text-text",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** The panel a `TabStrip` controls. Paired by id, so the ARIA
 *  relationship holds without either side knowing the other's markup. */
export function TabPanel({
  tabKey,
  className,
  children,
}: {
  tabKey: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${tabKey}`}
      aria-labelledby={`tab-${tabKey}`}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  );
}
