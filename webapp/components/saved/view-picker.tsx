"use client";

import * as React from "react";
import { ChevronDown, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import type { View } from "@/lib/types";

/**
 * Saved-view selector for /library — same UI shape as the granularity
 * tabs. Lets the user filter their saves to those matching one of their
 * saved views' criteria. Clicking the active view again (or the "Tout"
 * entry) clears the selection.
 *
 * Returns `null` for the view id when cleared.
 */
export function ViewPicker({
  views,
  currentViewId,
  onChange,
  disabled = false,
  allLabel,
  emptyLabel,
}: {
  views: View[];
  currentViewId: string | null;
  onChange: (viewId: string | null) => void;
  disabled?: boolean;
  /** Label for the "no view" entry inside the dropdown. */
  allLabel: string;
  /** Empty-state shown inside the dropdown if the user has no views yet. */
  emptyLabel: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = views.find((v) => v.id === currentViewId) ?? null;
  const label = active?.name ?? allLabel;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((s) => !s)}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
          "border text-[12px] font-medium",
          "transition-colors duration-100",
          disabled
            ? "bg-bg-sub text-text-4 border-border cursor-not-allowed"
            : active
              ? "bg-accent-soft text-accent-text border-accent/30 hover:brightness-105 cursor-pointer"
              : "bg-bg-elev text-text border-border hover:bg-bg-hover cursor-pointer",
          open && !disabled && "border-border-strong",
        )}
      >
        <Eye size={11} strokeWidth={1.7} />
        <span className="truncate max-w-[180px]">{label}</span>
        <ChevronDown
          size={11}
          strokeWidth={1.8}
          className={cn(
            "transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && !disabled && (
        <div
          role="menu"
          className={cn(
            "absolute left-0 top-9 z-30 min-w-[240px] py-1",
            "bg-bg-elev border border-border-strong rounded-md shadow-lg",
            "max-h-[60vh] overflow-y-auto",
          )}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "flex items-center w-full px-3 py-1.5 text-[12.5px] cursor-pointer",
              "hover:bg-bg-hover",
              !active ? "text-text font-medium" : "text-text-2",
            )}
          >
            <span className="flex items-center gap-2">
              {!active && (
                <span className="block w-1.5 h-1.5 rounded-full bg-accent" />
              )}
              <span className={cn(active && "ml-3.5")}>{allLabel}</span>
            </span>
          </button>

          {views.length === 0 ? (
            <div className="px-3 py-1.5 text-[11.5px] text-text-4 italic">
              {emptyLabel}
            </div>
          ) : (
            <>
              <div className="h-px bg-border my-1" />
              {views.map((v) => {
                const isActive = active?.id === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      onChange(v.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex items-center w-full",
                      "px-3 py-1.5 text-[12.5px] cursor-pointer",
                      "hover:bg-bg-hover",
                      isActive ? "text-text font-medium" : "text-text-2",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      {isActive && (
                        <span className="block w-1.5 h-1.5 rounded-full bg-accent" />
                      )}
                      <Eye
                        size={11}
                        strokeWidth={1.7}
                        className={cn(
                          "shrink-0",
                          isActive ? "text-text" : "text-text-3",
                        )}
                      />
                      <span className={cn(!isActive && "ml-0")}>{v.name}</span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
