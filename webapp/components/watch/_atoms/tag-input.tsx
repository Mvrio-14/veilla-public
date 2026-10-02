"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Tag/chip input — type a value, press Enter, it becomes a chip below.
 *
 * Common UX pattern (a.k.a. token input). Used for free-text keywords or
 * any list of strings the user wants to build incrementally.
 *
 *   - Enter         → adds the trimmed input as a new chip
 *   - Backspace on empty input → removes the last chip
 *   - Click X on a chip → removes that chip
 */
export function TagInput({
  values,
  onChange,
  placeholder,
  hint,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
}) {
  const t = useTranslations("common");
  const hintText = hint ?? t("tagInputHint");
  const [text, setText] = React.useState("");

  const add = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    setText("");
    if (values.includes(v)) return;
    onChange([...values, v]);
  };

  const remove = (v: string) => {
    onChange(values.filter((x) => x !== v));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      add(text);
    } else if (e.key === "Backspace" && !text && values.length > 0) {
      e.preventDefault();
      remove(values[values.length - 1]);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
          placeholder={placeholder}
          className="
            w-full px-3 py-2 pr-[120px] rounded-md
            bg-bg-sub border border-border
            text-[13px] text-text placeholder:text-text-4
            outline-none
            focus:border-text-4 focus:bg-bg-elev
            transition-colors
          "
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10.5px] text-text-4 pointer-events-none">
          {hintText}
        </span>
      </div>

      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className={cn(
                "inline-flex items-center gap-1",
                "pl-2 pr-1 py-0.5 rounded-full",
                "bg-accent-soft text-accent-text",
                "border border-accent/30",
                "text-[12px] font-medium",
              )}
            >
              {v}
              <button
                type="button"
                onClick={() => remove(v)}
                aria-label={t("removeItem", { name: v })}
                className="
                  inline-flex items-center justify-center
                  w-4 h-4 rounded-full
                  hover:bg-accent/20
                  cursor-pointer
                  transition-colors
                "
              >
                <X size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
