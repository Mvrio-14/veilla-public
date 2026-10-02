"use client";

import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const pillStyles = cva(
  cn(
    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full",
    "text-[12px] font-medium",
    "border transition-colors duration-100 cursor-pointer",
    "select-none",
  ),
  {
    variants: {
      active: {
        true: "bg-accent-soft text-accent-text border-accent/30 hover:brightness-105",
        false: "bg-bg-sub text-text-2 border-border hover:bg-bg-hover hover:text-text",
      },
    },
    defaultVariants: { active: false },
  },
);

/**
 * Toggleable chip used in the FiltersDialog (advanced filters).
 * Shows label + optional small count, active state via accent-soft background.
 */
export function FilterPill({
  label,
  count,
  active,
  onClick,
  title,
}: {
  label: React.ReactNode;
  count?: number;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={pillStyles({ active })}
    >
      <span>{label}</span>
      {typeof count === "number" && (
        <span
          className={cn(
            "text-[10.5px] tabular-nums",
            active ? "text-accent-text/70" : "text-text-4",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}
