"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, Save, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { MultiSelect, type MultiSelectGroup, type MultiSelectOption } from "./multi-select";
import { updatePreferences } from "@/lib/actions";
import { emptyAdvanced, normalizeAdvanced, type Advanced } from "@/lib/filter";
import { COUNTRY_CODES, REGION_ORDER, countryLabel, countryToRegion, regionLabel } from "@/lib/format";
import { useCategoryLabel } from "@/lib/use-category-label";
import { useChanged } from "@/lib/use-changed";

/**
 * Settings → Préférences form. Edits the user's persistent default
 * filters (the `users.preferences` JSONB column).
 *
 * Inclusion semantics: each multi-select lists what the user wants to
 * SEE. Empty selection = "no filter on this axis" — the standard pro
 * convention (Linear, Notion, Slack). Saved views are the place for
 * curated lenses (= inclusion with intent); preferences are the user's
 * editorial baseline applied on top of every Watch render.
 *
 * Fields covered here:
 *   - periodMinutes (1–168 h, editable combobox)
 *   - categories (16 canonical normalizer categories)
 *   - articleTypes (7 canonical types)
 *   - places (ISO country codes, grouped by region)
 *
 * The other Advanced fields (query, langs, feeds, persons, orgs,
 * source_country, exclusion lists, keywords) are intentionally not
 * exposed here — they're per-session lenses or live in FiltersDialog.
 * `toPersistShape` strips them on submit so saving never carries
 * stale ad-hoc state into the persisted shape.
 */

const CATEGORIES = [
  "Domestic Politics",
  "Geopolitics & Conflicts",
  "Justice & Legal Affairs",
  "Crime & Public Safety",
  "Economy",
  "Finance & Markets",
  "Business & Industry",
  "Energy & Climate",
  "Technology & AI",
  "Science",
  "Health",
  "Society & Labour",
  "Education",
  "Media & Culture",
  "Sport",
  "Other",
] as const;

const ARTICLE_TYPES = [
  "news",
  "feature",
  "opinion",
  "interview",
  "recap",
  "multimedia",
  "institutional",
] as const;

/** Curated subset of country ISO codes surfaced in the dropdown.
 *  Roughly = G20 + Western EU + key regional players, grouped by the
 *  COUNTRY_TO_REGION buckets defined in `lib/format.ts`. The user can
 *  always add more granular places via the FiltersDialog (which accepts
 *  free-text place names). */
// COUNTRY_CODES + REGION_ORDER moved to lib/format.ts so the filter
// picker (Advanced / view editor) reuses the same curated set.

/** Time-window presets exposed in the combobox dropdown. The user can
 *  also type any integer hour value within [WINDOW_MIN, WINDOW_MAX]. */
const WINDOW_PRESETS = [
  { key: "h6", hours: 6 },
  { key: "h12", hours: 12 },
  { key: "h24", hours: 24 },
  { key: "h48", hours: 48 },
  { key: "h72", hours: 72 },
  { key: "h168", hours: 168 },
] as const;

const WINDOW_MIN_HOURS = 1;
const WINDOW_MAX_HOURS = 168;

/** Strip everything except the four fields the form actually edits.
 *  Saving from Settings should never carry the inclusion lists or
 *  exclusion legacies from a previous shape — keep the persisted blob
 *  honest to what the UI surfaces. */
function toPersistShape(form: Advanced): Advanced {
  return {
    ...emptyAdvanced,
    periodMinutes: form.periodMinutes,
    categories: form.categories,
    articleTypes: form.articleTypes,
    places: form.places,
  };
}

function sameArray<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  // Sort with locale-agnostic compare so both string and number arrays
  // work — String() coerces numbers, comparison gives stable ordering.
  const cmp = (x: T, y: T): number => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);
  const sa = [...a].sort(cmp);
  const sb = [...b].sort(cmp);
  return sa.every((v, i) => v === sb[i]);
}

function sameForm(a: Advanced, b: Advanced): boolean {
  return (
    a.periodMinutes === b.periodMinutes &&
    sameArray(a.categories, b.categories) &&
    sameArray(a.articleTypes, b.articleTypes) &&
    sameArray(a.subjectCountries, b.subjectCountries)
  );
}

export function PreferencesForm({ initial }: { initial: Advanced }) {
  const t = useTranslations("settings.preferences");
  const tArticleTypes = useTranslations("settings.preferences.articleTypes");
  const categoryLabel = useCategoryLabel();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();

  // The server may store the full Advanced shape (saved view export,
  // legacy exclusion data, etc.) — collapse to our 4-field subset on
  // mount so dirty-tracking is honest.
  const initialPersisted = React.useMemo(
    // normalizeAdvanced fills any field missing from a pre-schema-change
    // payload — without it, downstream `sameArray(a.categories, …)` etc.
    // crashes on `.length` of undefined.
    () => toPersistShape(normalizeAdvanced(initial)),
    [initial],
  );

  const [form, setForm] = React.useState<Advanced>(initialPersisted);
  const [saving, setSaving] = React.useState(false);

  // A save round-trip hands back the stored preferences; the form
  // follows them. Done during render so `dirty` is never briefly true
  // against values that have already been written.
  if (useChanged(initialPersisted)) setForm(initialPersisted);

  const dirty = !sameForm(form, initialPersisted);
  const isDefault = sameForm(form, emptyAdvanced);

  const setWindow = (minutes: number) => {
    setForm((f) => ({ ...f, periodMinutes: minutes }));
  };

  /* ── Option lists derived per-locale ── */
  const categoryOptions: MultiSelectOption[] = React.useMemo(
    () => CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })),
    [categoryLabel],
  );

  const articleTypeOptions: MultiSelectOption[] = React.useMemo(
    () =>
      ARTICLE_TYPES.map((type) => ({
        value: type,
        label: tArticleTypes(type),
      })),
    [tArticleTypes],
  );

  /** Country groups by region. Codes outside our curated list — or in
   *  the catch-all "Other" bucket — fall back to a trailing group. */
  const countryGroups: MultiSelectGroup[] = React.useMemo(() => {
    const buckets: Record<string, MultiSelectOption[]> = {};
    for (const code of COUNTRY_CODES) {
      const region = countryToRegion(code);
      const label = countryLabel(code, locale) || code;
      (buckets[region] ??= []).push({ value: code, label });
    }
    // Sort countries within each region alphabetically by localized label.
    for (const region in buckets) {
      buckets[region].sort((a, b) => a.label.localeCompare(b.label, locale));
    }
    return REGION_ORDER.filter((r) => buckets[r]?.length).map((r) => ({
      key: r,
      label: regionLabel(r, locale),
      options: buckets[r],
    }));
  }, [locale]);

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await updatePreferences(toPersistShape(form));
      setForm(toPersistShape(saved));
      toast.show(t("saved"));
      router.refresh();
    } catch (err) {
      console.error("[settings] updatePreferences failed", err);
      toast.show(t("saveError"), "error");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => setForm(initialPersisted);
  const onReset = () => setForm(emptyAdvanced);

  return (
    <div className="space-y-7">
      {/* Time window — Word-style editable combobox: typeable input +
       *  preset dropdown. Stored in minutes server-side; the UI is
       *  hours-only. */}
      <Section
        label={t("timeWindow.label")}
        hint={t("timeWindow.hint")}
      >
        <HoursCombobox
          minutes={form.periodMinutes}
          onChange={setWindow}
        />
      </Section>

      {/* Categories to follow — inclusion. Empty = all categories. */}
      <Section
        label={t("categories.label")}
        hint={t("categories.hint")}
        count={form.categories.length}
      >
        <MultiSelect
          ariaLabel={t("categories.ariaLabel")}
          options={categoryOptions}
          values={form.categories}
          onChange={(next) => setForm((f) => ({ ...f, categories: next }))}
        />
      </Section>

      {/* Article types to follow — inclusion. Empty = all types. */}
      <Section
        label={t("articleTypes.label")}
        hint={t("articleTypes.hint")}
        count={form.articleTypes.length}
      >
        <MultiSelect
          ariaLabel={t("articleTypes.ariaLabel")}
          options={articleTypeOptions}
          values={form.articleTypes}
          onChange={(next) => setForm((f) => ({ ...f, articleTypes: next }))}
        />
      </Section>

      {/* Subject countries (= countries the article is ABOUT) — pulled
       *  from `Advanced.subjectCountries` (ISO codes). Was historically
       *  on `places` before the entity-migration split (`places` now
       *  carries `location` entity_ids). Grouped by region with
       *  per-region select-all. Empty = no geographic filter. */}
      <Section
        label={t("places.label")}
        hint={t("places.hint")}
        count={form.subjectCountries.length}
      >
        <MultiSelect
          ariaLabel={t("places.ariaLabel")}
          groups={countryGroups}
          values={form.subjectCountries}
          onChange={(next) => setForm((f) => ({ ...f, subjectCountries: next }))}
        />
      </Section>

      {/* Action bar — sticky footer feel without sticky positioning */}
      <div
        className={cn(
          "flex items-center gap-2 pt-4 border-t border-border",
          "sticky bottom-0 bg-bg pb-1 -mx-8 px-8",
        )}
      >
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "text-[12.5px] font-medium",
            "border border-accent/40 bg-accent text-bg",
            "hover:brightness-105 transition",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <Save size={13} strokeWidth={1.9} />
          {t("save")}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={!dirty || saving}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "text-[12.5px] font-medium",
            "border border-border bg-bg-sub text-text-2",
            "hover:bg-bg-hover hover:text-text transition",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <X size={13} strokeWidth={1.9} />
          {t("cancel")}
        </button>

        <button
          type="button"
          onClick={onReset}
          disabled={isDefault || saving}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md ml-auto",
            "text-[12px] font-medium",
            "text-text-3 hover:text-text hover:bg-bg-hover transition",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <RotateCcw size={12} strokeWidth={1.8} />
          {t("reset")}
        </button>

        {dirty && (
          <span className="text-[11px] text-text-4 italic">
            {t("unsavedHint")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Editable combobox for the time window, à la Word's font-size picker.
 *
 * The user can either:
 *   - Click the input and type a number of hours (1–168)
 *   - Click the chevron / focus the input → preset dropdown opens
 *
 * Stored as minutes on the form (= the canonical `periodMinutes` shape
 * shared with the FiltersDialog), displayed as hours. Empty input
 * commits to 0 = no time filter. Out-of-range input is clamped on
 * commit with a brief red flash so the user notices.
 */
function HoursCombobox({
  minutes,
  onChange,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
}) {
  const t = useTranslations("settings.preferences.timeWindow");
  const hours = minutes === 0 ? "" : Math.round(minutes / 60).toString();
  const [text, setText] = React.useState<string>(hours);
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Re-sync the input text whenever the upstream value changes (e.g.
  // Reset to defaults wipes `minutes` back to 0). During render, so the
  // box never shows the old duration for a frame after a reset.
  if (useChanged(minutes)) {
    setText(minutes === 0 ? "" : Math.round(minutes / 60).toString());
    setError(false);
  }

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const commit = () => {
    const raw = text.trim();
    if (raw === "") {
      onChange(0);
      setError(false);
      setOpen(false);
      return;
    }
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < WINDOW_MIN_HOURS || n > WINDOW_MAX_HOURS) {
      // Flash red briefly then snap back to the last committed value.
      setError(true);
      window.setTimeout(() => {
        setText(minutes === 0 ? "" : Math.round(minutes / 60).toString());
        setError(false);
      }, 800);
      setOpen(false);
      return;
    }
    onChange(n * 60);
    setText(n.toString());
    setError(false);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      setText(minutes === 0 ? "" : Math.round(minutes / 60).toString());
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  return (
    <div ref={wrapRef} className="relative w-[108px]">
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          setOpen(true);
          inputRef.current?.select();
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={t("ariaLabel")}
        className={cn(
          "w-full px-3 pr-12 py-2 rounded-md",
          "bg-bg-sub border text-[13px] text-text placeholder:text-text-4",
          "outline-none transition-colors tabular-nums",
          error
            ? "border-hot bg-hot-soft"
            : "border-border focus:border-text-4 focus:bg-bg-elev",
        )}
      />
      {/* Unit suffix — sits inside the input, before the chevron. */}
      <span className="absolute right-7 top-1/2 -translate-y-1/2 text-[12px] text-text-4 pointer-events-none">
        {t("unit")}
      </span>
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        aria-label={t("viewPresets")}
        className={cn(
          "absolute right-1.5 top-1/2 -translate-y-1/2",
          "inline-flex items-center justify-center",
          "w-6 h-6 rounded",
          "text-text-4 hover:text-text-2 hover:bg-bg-hover",
          "transition-colors cursor-pointer",
        )}
      >
        <ChevronDown size={12} strokeWidth={1.8} />
      </button>

      {open && (
        <div
          role="listbox"
          className={cn(
            "absolute top-full left-0 right-0 mt-1 z-50",
            "bg-bg-elev border border-border",
            "rounded-md shadow-md overflow-hidden",
            "max-h-[260px] overflow-y-auto",
          )}
        >
          {WINDOW_PRESETS.map((p) => {
            const currentHours = Math.round(minutes / 60);
            const active = currentHours === p.hours;
            return (
              <button
                key={p.key}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(p.hours * 60);
                  setText(p.hours.toString());
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-1.5 text-[12px] cursor-pointer",
                  "transition-colors",
                  active
                    ? "bg-accent-soft text-accent-text font-medium"
                    : "text-text-2 hover:bg-bg-hover hover:text-text",
                )}
              >
                {/* Label is fully translated (e.g. "12 heures" / "12 hours"),
                 *  and the trailing "(168 h)" hint on the 7-day option makes
                 *  the canonical unit visible even there. */}
                {t(p.key)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  hint,
  count,
  children,
}: {
  label: string;
  hint?: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-1">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-text-3">
          {label}
        </h2>
        {count !== undefined && count > 0 && (
          <span className="text-[10.5px] font-semibold tabular-nums text-accent-text">
            {count}
          </span>
        )}
      </div>
      {hint && (
        <p className="text-[12px] text-text-4 leading-relaxed mb-2.5">{hint}</p>
      )}
      {children}
    </section>
  );
}
