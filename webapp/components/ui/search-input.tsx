"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Search field for list surfaces.
 *
 * - `size="md"` (default): the full-height field of the list toolbars.
 *   `grow` fills the row; otherwise it is fixed-width.
 * - `size="sm"`: the compact pill that sits inside a list header (Watch,
 *   Library). Carries its own clear button; `inputClassName` sets the
 *   width of the text box, which differs per header.
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  size = "md",
  grow = false,
  className,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "md" | "sm";
  grow?: boolean;
  className?: string;
  inputClassName?: string;
}) {
  const t = useTranslations("common");

  if (size === "sm") {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1",
          "rounded-md border border-border bg-bg-sub",
          "text-text-3 transition-colors",
          "focus-within:border-text-4 focus-within:bg-bg-elev",
          className,
        )}
      >
        <Search size={11} strokeWidth={1.8} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? t("search")}
          spellCheck={false}
          autoComplete="off"
          className={cn(
            "bg-transparent outline-none text-[12px] text-text placeholder:text-text-4 min-w-0",
            inputClassName,
          )}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-text-4 hover:text-text-2 cursor-pointer"
            aria-label={t("clear")}
          >
            <X size={11} strokeWidth={1.8} />
          </button>
        )}
      </div>
    );
  }

  return (
    <label
      className={cn(
        "flex items-center gap-2 h-9 px-3 rounded-md",
        "border border-border bg-bg-elev text-text-3",
        "focus-within:border-border-strong focus-within:text-text-2",
        "transition-colors duration-100",
        grow ? "flex-1 min-w-0" : "w-[260px] shrink-0",
        className,
      )}
    >
      <Search size={13} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "flex-1 min-w-0 bg-transparent border-0 outline-none text-[13px] text-text placeholder:text-text-4",
          inputClassName,
        )}
      />
    </label>
  );
}
