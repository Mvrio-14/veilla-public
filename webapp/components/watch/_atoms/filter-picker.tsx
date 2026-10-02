"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { FilterPill, TagInput } from ".";
import { MultiSelect, type MultiSelectGroup } from "@/components/settings/multi-select";
import { cn } from "@/lib/utils";
import type { Advanced } from "@/lib/filter";
import {
  COUNTRY_CODES,
  REGION_ORDER,
  countryLabel,
  countryToRegion,
  langLabel,
  regionLabel,
} from "@/lib/format";
import type { Aggregations } from "@/lib/aggregate";
import type { WatchUniverse } from "@/lib/types";
import { useCategoryLabel } from "@/lib/use-category-label";

// Canonical article_type values from the normalizer (src/normalizer.py).
const ARTICLE_TYPE_VALUES = [
  "news",
  "feature",
  "opinion",
  "interview",
  "recap",
  "multimedia",
  "institutional",
] as const;

/**
 * Pure filter form — used inside both `FiltersDialog` (apply ad-hoc) and
 * `ViewEditDialog` (define a saved view's criteria). All the per-section
 * inputs live here; the parent wraps it with a Dialog shell + appropriate
 * footer buttons.
 *
 * `mode` controls two behaviors :
 *   - "adhoc" — user filters what's currently in the watch. Per-value
 *     counts are shown on pills, and Persons/Orgs/Places are rendered as
 *     pills sourced from `aggs`.
 *   - "view"  — user defines forward-looking criteria for a saved view.
 *     Counts are hidden (the current watch's count is misleading for a
 *     permanent rule) and Persons/Orgs/Places are rendered as TagInput so
 *     the user can type any name, even one that doesn't appear in the
 *     current data.
 *
 * The other facets (Categories / Languages / Feeds / Origin) come from a
 * finite, stable universe and stay as pills in both modes — just without
 * counts in view mode.
 */
export function FilterPicker({
  draft,
  setDraft,
  aggs,
  universe,
  mode = "adhoc",
}: {
  draft: Advanced;
  setDraft: React.Dispatch<React.SetStateAction<Advanced>>;
  aggs: Aggregations;
  /** Full universe of filterable values, ignored in adhoc mode. Required
   *  in view mode if you want to see ALL languages / countries /
   *  categories / feeds (independent of what's in the current watch). */
  universe?: WatchUniverse;
  mode?: "adhoc" | "view";
}) {
  const showCounts = mode === "adhoc";
  const useUniverse = mode === "view" && universe !== undefined;
  const t = useTranslations("filtersDialog");
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();

  const toggleIn = React.useCallback(
    (key: keyof Advanced, value: string) => {
      setDraft((d) => {
        const cur = d[key] as string[];
        const next = cur.includes(value)
          ? cur.filter((v) => v !== value)
          : [...cur, value];
        return { ...d, [key]: next };
      });
    },
    [setDraft],
  );

  // Entity-typed equivalent (persons / orgs / places / events / markets
  // / products) — those fields are number[] (canonical entity_id), so
  // the string variant above doesn't apply. SearchablePillRow exposes a string key for
  // its API; we cast on both sides.
  const toggleEntity = React.useCallback(
    (key: "persons" | "orgs" | "places" | "events" | "markets" | "products",
     value: number) => {
      setDraft((d) => {
        const cur = d[key] as number[];
        const next = cur.includes(value)
          ? cur.filter((v) => v !== value)
          : [...cur, value];
        return { ...d, [key]: next };
      });
    },
    [setDraft],
  );

  /** Region-grouped country options for the MultiSelect dropdowns.
   *  Built from the curated `COUNTRY_CODES` list (same set as
   *  /settings/preferences) so both geo sections offer a stable,
   *  forward-looking universe regardless of what's in today's watch.
   *  Localized country labels sorted alphabetically within each region. */
  const countryGroups: MultiSelectGroup[] = React.useMemo(() => {
    const buckets: Record<string, { value: string; label: string }[]> = {};
    for (const code of COUNTRY_CODES) {
      const region = countryToRegion(code);
      buckets[region] ??= [];
      buckets[region].push({
        value: code,
        label: countryLabel(code, locale) || code,
      });
    }
    for (const region in buckets) {
      buckets[region].sort((a, b) => a.label.localeCompare(b.label, locale));
    }
    return REGION_ORDER.filter((r) => buckets[r]?.length).map((r) => ({
      key: r,
      label: regionLabel(r, locale),
      options: buckets[r],
    }));
  }, [locale]);

  /** Shorthand: count to display on a pill, or undefined when counts are off. */
  const c = (n: number | undefined) => (showCounts ? n : undefined);

  /* ── View mode value sets ──
   * In view mode (when universe is provided), use the FULL universe of
   * filterable values instead of the watch-current `aggs`. The user is
   * defining a forward-looking rule; values absent from today's watch may
   * still be meaningful tomorrow.
   *
   * Each fallback to `aggs` mirrors the adhoc shape so the same render
   * code below covers both modes.  */

  type CategoryOpt = { name: string; count?: number };
  const categoryOptions: CategoryOpt[] =
    useUniverse && universe
      ? universe.categories.map((name) => ({ name }))
      : aggs.categories;

  type LangOpt = { code: string; count?: number };
  const langOptions: LangOpt[] =
    useUniverse && universe
      ? universe.langs.map((code) => ({ code }))
      : aggs.langs;

  type FeedOpt = {
    name: string;
    country: string | null;
    region: string;
    count?: number;
  };
  const feedOptions: FeedOpt[] =
    useUniverse && universe
      ? universe.feeds.map((f) => ({
          name: f.name,
          country: f.country,
          region: regionLabel(countryToRegion(f.country), locale),
        }))
      : aggs.feeds;

  return (
    <div className="space-y-5">
      {/* No period field here: the PeriodSelector in the /watch header
       *  is the single source of truth for the time window (see
       *  src/retention.py). A field here would create three inconsistent
       *  knobs — this dialog, the view editor, and the top selector. */}

      {/* Keywords — cumulative tag input (AND match) */}
      <Section
        label={t("keywords")}
        hint={t("keywordsHint")}
        count={draft.keywords.length}
      >
        <TagInput
          values={draft.keywords}
          onChange={(next) => setDraft((d) => ({ ...d, keywords: next }))}
          placeholder={t("keywordsPlaceholder")}
        />
      </Section>

      {categoryOptions.length > 0 && (
        <Section label={t("categories")} count={draft.categories.length}>
          <PillRow>
            {categoryOptions.map((cat) => (
              <FilterPill
                key={cat.name}
                label={categoryLabel(cat.name)}
                count={c(cat.count)}
                active={draft.categories.includes(cat.name)}
                onClick={() => toggleIn("categories", cat.name)}
              />
            ))}
          </PillRow>
        </Section>
      )}

      {langOptions.length > 0 && (
        <Section label={t("languages")} count={draft.langs.length}>
          <PillRow>
            {langOptions.map((l) => (
              <FilterPill
                key={l.code}
                label={langLabel(l.code, locale)}
                count={c(l.count)}
                active={draft.langs.includes(l.code)}
                onClick={() => toggleIn("langs", l.code)}
              />
            ))}
          </PillRow>
        </Section>
      )}

      {feedOptions.length > 0 && (
        <Section
          label={t("feeds")}
          count={draft.feeds.length}
          hint={t("feedsAvailable", { count: feedOptions.length })}
        >
          <PillRow scrollable>
            {feedOptions.map((f) => (
              <FilterPill
                key={f.name}
                label={f.name}
                count={c(f.count)}
                active={draft.feeds.includes(f.name)}
                onClick={() => toggleIn("feeds", f.name)}
                title={`${f.region}${f.country ? ` · ${f.country}` : ""}`}
              />
            ))}
          </PillRow>
        </Section>
      )}

      {/* Origine — country the SOURCE publishes from (article.source_country).
       *  Region-grouped dropdown with checkboxes (same component as the
       *  settings preferences picker). */}
      <Section
        label={t("originLabel")}
        count={draft.countries.length}
        hint={t("originHint")}
      >
        <MultiSelect
          groups={countryGroups}
          values={draft.countries}
          onChange={(next) => setDraft((d) => ({ ...d, countries: next }))}
          ariaLabel={t("originLabel")}
        />
      </Section>

      {/* Subject countries — countries the article is ABOUT
       *  (article.countries, normalizer-tagged). Structured ISO codes,
       *  clean by design. This is the alert-grade subject-geo filter. */}
      <Section
        label={t("subjectCountriesLabel")}
        count={draft.subjectCountries.length}
        hint={t("subjectCountriesHint")}
      >
        <MultiSelect
          groups={countryGroups}
          values={draft.subjectCountries}
          onChange={(next) =>
            setDraft((d) => ({ ...d, subjectCountries: next }))
          }
          ariaLabel={t("subjectCountriesLabel")}
        />
      </Section>

      {/* Entity sections (persons / orgs / locations / events / markets
       *  / products). Backed by canonical Wikidata entity_id, which is
       *  not typeable, so there is no free-text entry. Users add/remove via the sidebar
       *  SearchablePillRow which is drawn from the live aggregations
       *  (= the entities actually mentioned in their universe). */}
      {aggs.entities.locations.length > 0 && (
        <Section
          label={t("places")}
          count={draft.places.length}
          hint={t("placesHint")}
        >
          <SearchablePillRow
            items={aggs.entities.locations.map((l) => ({
              key:    String(l.entity_id),
              label:  l.name,
              count:  c(l.count),
              active: draft.places.includes(l.entity_id),
            }))}
            onToggle={(key) => toggleEntity("places", Number(key))}
            placeholder={t("placesPlaceholder")}
          />
        </Section>
      )}

      {aggs.entities.persons.length > 0 && (
        <Section label={t("persons")} count={draft.persons.length}>
          <SearchablePillRow
            items={aggs.entities.persons.map((p) => ({
              key:    String(p.entity_id),
              label:  p.name,
              count:  c(p.count),
              active: draft.persons.includes(p.entity_id),
            }))}
            onToggle={(key) => toggleEntity("persons", Number(key))}
            placeholder={t("personsPlaceholder")}
          />
        </Section>
      )}

      {aggs.entities.orgs.length > 0 && (
        <Section label={t("organizations")} count={draft.orgs.length}>
          <SearchablePillRow
            items={aggs.entities.orgs.map((o) => ({
              key:    String(o.entity_id),
              label:  o.name,
              count:  c(o.count),
              active: draft.orgs.includes(o.entity_id),
            }))}
            onToggle={(key) => toggleEntity("orgs", Number(key))}
            placeholder={t("organizationsPlaceholder")}
          />
        </Section>
      )}

      {aggs.entities.events.length > 0 && (
        <Section label={t("events")} count={draft.events.length}>
          <SearchablePillRow
            items={aggs.entities.events.map((e) => ({
              key:    String(e.entity_id),
              label:  e.name,
              count:  c(e.count),
              active: draft.events.includes(e.entity_id),
            }))}
            onToggle={(key) => toggleEntity("events", Number(key))}
            placeholder={t("eventsPlaceholder")}
          />
        </Section>
      )}

      {aggs.entities.markets.length > 0 && (
        <Section label={t("markets")} count={draft.markets.length}>
          <SearchablePillRow
            items={aggs.entities.markets.map((m) => ({
              key:    String(m.entity_id),
              label:  m.name,
              count:  c(m.count),
              active: draft.markets.includes(m.entity_id),
            }))}
            onToggle={(key) => toggleEntity("markets", Number(key))}
            placeholder={t("marketsPlaceholder")}
          />
        </Section>
      )}

      {aggs.entities.products.length > 0 && (
        <Section label={t("products")} count={draft.products.length}>
          <SearchablePillRow
            items={aggs.entities.products.map((p) => ({
              key:    String(p.entity_id),
              label:  p.name,
              count:  c(p.count),
              active: draft.products.includes(p.entity_id),
            }))}
            onToggle={(key) => toggleEntity("products", Number(key))}
            placeholder={t("productsPlaceholder")}
          />
        </Section>
      )}

      {/* Article types — canonical 7-value enum from the normalizer. Same
       *  inclusion semantic as the other facets above (OR within type, AND
       *  with the rest). */}
      <Section label={t("articleTypes")} count={draft.articleTypes.length}>
        <PillRow>
          {ARTICLE_TYPE_VALUES.map((type) => (
            <FilterPill
              key={type}
              label={t(`articleTypeLabels.${type}`)}
              active={draft.articleTypes.includes(type)}
              onClick={() => toggleIn("articleTypes", type)}
            />
          ))}
        </PillRow>
      </Section>

      {/* ── Exclusions block ── */}
      <div className="pt-3 mt-2 border-t border-border">
        <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-text-3 mb-1">
          {t("exclusionsHeader")}
        </div>
        <p className="text-[11.5px] text-text-4 leading-relaxed mb-4">
          {t("exclusionsHint")}
        </p>

        <div className="space-y-5">
          {categoryOptions.length > 0 && (
            <Section
              label={t("excludedCategories")}
              count={draft.excludedCategories.length}
            >
              <PillRow>
                {categoryOptions.map((cat) => (
                  <FilterPill
                    key={`x-${cat.name}`}
                    label={categoryLabel(cat.name)}
                    count={c(cat.count)}
                    active={draft.excludedCategories.includes(cat.name)}
                    onClick={() => toggleIn("excludedCategories", cat.name)}
                  />
                ))}
              </PillRow>
            </Section>
          )}

          <Section
            label={t("excludedArticleTypes")}
            count={draft.excludedArticleTypes.length}
          >
            <PillRow>
              {ARTICLE_TYPE_VALUES.map((type) => (
                <FilterPill
                  key={`x-${type}`}
                  label={t(`articleTypeLabels.${type}`)}
                  active={draft.excludedArticleTypes.includes(type)}
                  onClick={() => toggleIn("excludedArticleTypes", type)}
                />
              ))}
            </PillRow>
          </Section>

          <Section
            label={t("excludedKeywords")}
            count={draft.excludedKeywords.length}
          >
            <TagInput
              values={draft.excludedKeywords}
              onChange={(next) =>
                setDraft((d) => ({ ...d, excludedKeywords: next }))
              }
              placeholder={t("excludedKeywordsPlaceholder")}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ─────────── Internal sub-components ─────────── */

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
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3">
          {label}
        </span>
        {count !== undefined && count > 0 && (
          <span className="text-[10.5px] font-semibold tabular-nums text-accent-text">
            {count}
          </span>
        )}
        {hint && (
          <span className="text-[11px] text-text-4 ml-auto">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function PillRow({
  children,
  scrollable,
}: {
  children: React.ReactNode;
  scrollable?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5",
        scrollable && "max-h-[160px] overflow-y-auto pr-1",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Pill row with an integrated mini search input — used for long entity lists
 * (Persons, Organizations, Places). Always shows currently-active pills,
 * plus any others matching the search text. Match is on the label,
 * accent-folded.
 */
function SearchablePillRow({
  items,
  onToggle,
  placeholder,
}: {
  items: {
    key: string;
    label: string;
    count?: number;
    active: boolean;
    title?: string;
  }[];
  onToggle: (key: string) => void;
  placeholder: string;
}) {
  const t = useTranslations("filtersDialog");
  const [q, setQ] = React.useState("");
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  const needle = norm(q.trim());

  const visible = needle
    ? items.filter((it) => it.active || norm(it.label).includes(needle))
    : items;

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          size={11}
          strokeWidth={1.8}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-4 pointer-events-none"
        />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          className="
            w-full pl-7 pr-2.5 py-1.5 rounded-md
            bg-bg-sub border border-border
            text-[12px] text-text placeholder:text-text-4
            outline-none focus:border-text-4 focus:bg-bg-elev
            transition-colors
          "
        />
      </div>
      <PillRow scrollable>
        {visible.map((it) => (
          <FilterPill
            key={it.key}
            label={it.label}
            count={it.count}
            active={it.active}
            onClick={() => onToggle(it.key)}
            title={it.title}
          />
        ))}
        {visible.length === 0 && (
          <span className="text-[11.5px] text-text-4 italic px-1 py-1">
            {t("noResults")}
          </span>
        )}
      </PillRow>
    </div>
  );
}
