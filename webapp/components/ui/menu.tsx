"use client";

import * as React from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Dropdown menu — trigger button + floating panel.
 *
 * Deliberately not the shadcn/Base UI `DropdownMenu`: that component is
 * built for command menus (roving focus, typeahead, auto-close on any
 * item). Ours is mostly a *filter* surface where several items are
 * toggled in a row, so closing on the first click would be wrong. Hence
 * `closeOnSelect`, off by default for multi-select uses.
 *
 * Dismissal is the usual pair — click outside, Escape — with focus
 * returned to the trigger so keyboard users don't get dropped at the top
 * of the document.
 */
export function Menu({
  label,
  count,
  active,
  align = "start",
  closeOnSelect = false,
  className,
  children,
}: {
  label: React.ReactNode;
  /** Shown as a small tally on the trigger. Omit when zero. */
  count?: number;
  /** Force the "has a value" styling (solid fill). */
  active?: boolean;
  align?: "start" | "end";
  closeOnSelect?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const isActive = active ?? (count ?? 0) > 0;

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        // Solid neutral fill when something is set, never a warm tint:
        // the accent carries links and active state, and a colour that
        // means two things means neither. A filled button is also simply
        // louder than a tinted outline — which is the point, since an
        // active filter that goes unnoticed makes the list below lie.
        className={cn(
          "inline-flex items-center gap-1.5 h-9 px-3 rounded-md cursor-pointer",
          "border text-[13px] whitespace-nowrap",
          "transition-colors duration-100",
          isActive
            ? "border-text bg-text text-bg font-semibold hover:bg-text-2 hover:border-text-2"
            : "border-border bg-bg-elev text-text-2 font-medium hover:border-border-strong hover:text-text",
        )}
      >
        {label}
        {count ? (
          <span
            className={cn(
              "font-mono text-[10px]",
              isActive
                ? "px-1.5 rounded-full bg-bg/30 text-bg"
                : "text-text-4",
            )}
          >
            {count}
          </span>
        ) : null}
        <ChevronDown size={12} strokeWidth={2} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          onClick={closeOnSelect ? () => setOpen(false) : undefined}
          className={cn(
            "absolute top-[calc(100%+4px)] z-50 min-w-[200px] max-h-[60vh] overflow-y-auto",
            "rounded-md border border-border-strong bg-bg-elev p-1 shadow-lg",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** Section heading inside a menu. */
export function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[9px] tracking-[0.16em] uppercase text-text-4 px-2 pt-[7px] pb-1">
      {children}
    </div>
  );
}

/** One selectable row. `count` renders the tally on the right. */
export function MenuItem({
  selected,
  count,
  disabled,
  onSelect,
  children,
}: {
  selected?: boolean;
  count?: number;
  disabled?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={!!selected}
      disabled={disabled}
      onClick={onSelect}
      // A filled row, not just a tick. Scanning twenty values for a 11px
      // check is work; a filled band is read without looking for it.
      className={cn(
        "flex items-center gap-2 w-full px-2 py-1.5 rounded-md cursor-pointer",
        "text-[12px] text-left transition-colors duration-100",
        selected
          ? "bg-bg-active text-text font-semibold hover:bg-bg-active"
          : "text-text-2 hover:bg-bg-hover hover:text-text",
        disabled && "opacity-45 pointer-events-none",
      )}
    >
      <span className="w-3 shrink-0">
        {selected && <Check size={11} strokeWidth={2.6} aria-hidden />}
      </span>
      <span className="min-w-0 truncate">{children}</span>
      {count != null && (
        <span className="ml-auto pl-3 font-mono text-[10px] text-text-4">
          {count}
        </span>
      )}
    </button>
  );
}
