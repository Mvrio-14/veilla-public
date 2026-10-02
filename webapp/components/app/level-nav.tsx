"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The rows and headings a screen's own navigation is made of, in the
 * app sidebar's second level — the same metrics as the sidebar's main
 * entries, so the two levels read as one surface.
 */

export function LevelHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center h-6 mt-3.5 mb-[3px] pl-2">
      <span className="flex-1 font-mono text-[9px] tracking-[0.16em] uppercase text-text-4">
        {children}
      </span>
      {action}
    </div>
  );
}

/** A link when given `href`, a button when given `onSelect`. */
export function LevelRow({
  href,
  onSelect,
  icon,
  label,
  count,
  active,
}: {
  href?: string;
  onSelect?: () => void;
  icon?: ReactNode;
  label: string;
  count?: number;
  active: boolean;
}) {
  const className = cn(
    "flex items-center gap-2.5 w-full h-8 px-2 rounded-md whitespace-nowrap text-left",
    "transition-colors duration-100",
    active ? "bg-bg-active text-text font-medium" : "text-text-2 hover:bg-bg-hover hover:text-text",
  );
  const body = (
    <>
      {icon && <span className={cn("shrink-0", active ? "text-text" : "text-text-3")}>{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 font-mono text-[10px] text-text-4">{count}</span>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} aria-current={active ? "page" : undefined} className={className}>
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onSelect} aria-pressed={active} className={cn(className, "cursor-pointer")}>
      {body}
    </button>
  );
}
