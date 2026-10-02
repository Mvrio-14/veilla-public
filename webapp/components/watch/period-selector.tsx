"use client";

import * as React from "react";
import { Clock, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Global period selector for the /watch surface.
 *
 * The active value gates ALL time-filtered content in /watch:
 *  - the story list body
 *  - the per-view badges in the sidebar (`/me/views/counts?period_hours=`)
 *  - the sidebar counters for entities/feeds/etc.
 *
 * Values match `SPA_PERIOD_PRESETS_H` in `src/retention.py` — if the
 * backend ships a new preset, add it here too. The retention cap
 * (widest preset) is the 14-day DB cleanup boundary; nothing above
 * that is exposed because those articles are physically gone.
 */
const PRESETS = [
  { hours: 1,   labelKey: "period1h"  },
  { hours: 6,   labelKey: "period6h"  },
  { hours: 24,  labelKey: "period24h" },
  { hours: 72,  labelKey: "period3d"  },
  { hours: 168, labelKey: "period7d"  },
  { hours: 336, labelKey: "period14d" },
] as const;

export function PeriodSelector({
  value,
  onChange,
}: {
  value:    number;
  onChange: (hours: number) => void;
}) {
  const t = useTranslations("period");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Snap the current value to the nearest preset for the button label —
  // covers the case where a legacy URL or a resurrected view supplies
  // something exotic like 48h. If nothing matches exactly, we fall back
  // to displaying the raw hours count.
  const activePreset = PRESETS.find((p) => p.hours === value);
  const activeLabel = activePreset ? t(activePreset.labelKey) : `${value}h`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("tooltip")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
          "border bg-bg-elev text-text-2 border-border",
          "hover:bg-bg-hover hover:text-text",
          "text-[12px] font-medium cursor-pointer",
          "transition-colors duration-100",
        )}
      >
        <Clock size={11} strokeWidth={1.6} />
        <span>{activeLabel}</span>
      </button>
      {open && (
        <div
          className={cn(
            "absolute top-full right-0 mt-1 z-20 w-40",
            "rounded-md border border-border bg-bg-elev shadow-lg",
            "py-1",
          )}
          role="menu"
        >
          {PRESETS.map((p) => {
            const active = p.hours === value;
            return (
              <button
                key={p.hours}
                type="button"
                onClick={() => {
                  onChange(p.hours);
                  setOpen(false);
                }}
                className={cn(
                  "w-full flex items-center justify-between",
                  "px-3 py-1.5 text-[12px]",
                  "hover:bg-bg-hover",
                  active ? "text-text font-medium" : "text-text-2",
                )}
                role="menuitem"
              >
                <span>{t(p.labelKey)}</span>
                {active && <Check size={12} strokeWidth={1.8} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
