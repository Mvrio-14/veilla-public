"use client";

import { Filter } from "lucide-react";
import { useTranslations } from "next-intl";
import { Menu, MenuHeading, MenuItem } from "@/components/ui/menu";

/**
 * The "Filter" control — one menu holding every filterable field of the
 * current surface, values accumulating across fields.
 *
 * ## One button rather than a row of per-field controls
 *
 * The number of fields changes with the item kind, and a row that reflows
 * as you switch kinds is disorienting. So a single trigger, which turns
 * into a solid button carrying the total the moment anything is set.
 *
 * ## Why no chips beside it
 *
 * Tried, removed. Repeating each active value outside the menu duplicated
 * what the menu already shows — the selected rows are filled — and pushed
 * the table down as the values piled up. The trigger says how many
 * filters are on, the menu says which; one click covers the gap, and the
 * toolbar stays one line tall.
 *
 * ## Counts
 *
 * Counts next to each value answer "what would this click give me", so
 * they are computed with the *other* fields still applied and the field
 * being opened released — that's the caller's job via `count`.
 */

export type FilterField = {
  key: string;
  label: string;
  /** Currently selected values. */
  value: string[];
  options: { value: string; label: string; count?: number }[];
  onChange: (next: string[]) => void;
};

export function FilterMenu({
  fields,
  onReset,
}: {
  fields: FilterField[];
  onReset: () => void;
}) {
  const t = useTranslations("filters");
  const total = fields.reduce((sum, f) => sum + f.value.length, 0);

  const toggle = (field: FilterField, value: string) =>
    field.onChange(
      field.value.includes(value)
        ? field.value.filter((v) => v !== value)
        : [...field.value, value],
    );

  return (
    <Menu
      count={total || undefined}
      label={
        <>
          <Filter size={12} strokeWidth={1.8} aria-hidden />
          {t("filter")}
        </>
      }
    >
      {total > 0 && (
        <button
          type="button"
          onClick={onReset}
          className="block w-full text-left px-2 py-1.5 mb-1 border-b border-border text-[12px] text-text-3 hover:bg-bg-hover hover:text-text cursor-pointer"
        >
          {t("reset")}
        </button>
      )}
      {fields.map((field, i) => (
        <div
          key={field.key}
          className={i > 0 ? "mt-1 pt-1.5 border-t border-border" : undefined}
        >
          <MenuHeading>{field.label}</MenuHeading>
          {field.options.map((option) => (
            <MenuItem
              key={option.value}
              selected={field.value.includes(option.value)}
              count={option.count}
              onSelect={() => toggle(field, option.value)}
            >
              {option.label}
            </MenuItem>
          ))}
        </div>
      ))}
    </Menu>
  );
}
