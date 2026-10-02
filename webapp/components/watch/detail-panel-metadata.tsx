"use client";

import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { countryLabel } from "@/lib/format";
import type { Article, LinkedEntity } from "@/lib/types";
import {
  aggregateStoryCountries,
  aggregateStoryEntities,
  relativeAge,
  type RankedItem,
} from "@/lib/story-metadata";

/**
 * Single chip with an optional trailing count. Count is hidden when
 * undefined (article-level usage where there's no aggregation), and
 * rendered in mono with a subtle separator at the story level.
 */
function Chip({ label, count }: { label: string; count?: number }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        "px-2 py-0.5 rounded-full",
        "bg-bg-sub border border-border",
        "text-[12px] leading-none text-text-2",
        "whitespace-nowrap",
      )}
    >
      <span className="truncate max-w-[180px]">{label}</span>
      {count !== undefined && count > 1 && (
        <>
          <span className="text-text-4" aria-hidden>·</span>
          <span className="font-mono tabular-nums text-[11px] text-text-3">
            {count}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Inline row of chips. The wrapper is a flex with gap + wrap so chips
 * flow naturally and reflow on panel resize. Renders nothing when items
 * is empty.
 */
function ChipRow({ items }: { items: { label: string; count?: number }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <Chip key={`${it.label}|${it.count ?? "-"}`} label={it.label} count={it.count} />
      ))}
    </div>
  );
}

/** Small label above a chip row, in the same style as the section
 *  headings but lighter so the chip content reads as the primary content
 *  and the label as scaffolding. */
function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-3 mb-1.5">
      {children}
    </div>
  );
}

/**
 * Renders the 6 entity sub-blocks (persons / orgs / locations / events /
 * markets / products) as stacked sections. Each block is skipped when
 * its array is empty. Returns null if all six are empty (so callers can
 * safely render `<EntitiesBlock />` without conditional checks).
 *
 * Used both at the article level (raw entities from the LLM extractor)
 * and at the story level (after aggregateStoryEntities). The story
 * variant carries counts; the article variant doesn't.
 */
type EntityList = { label: string; count?: number }[];

function EntitiesBlock({
  persons,
  orgs,
  locations,
  events,
  markets,
  products,
}: {
  persons:   EntityList;
  orgs:      EntityList;
  locations: EntityList;
  events:    EntityList;
  markets:   EntityList;
  products:  EntityList;
}) {
  const t = useTranslations("detail");
  const total =
    persons.length + orgs.length + locations.length +
    events.length + markets.length + products.length;
  if (total === 0) return null;

  // Render order: people first (most prominent), then orgs/locations
  // (classic "who/where"), then events, markets and products
  // (when/which markets/which products). Order tracks how readers parse a story.
  const sections: { key: string; label: string; items: EntityList }[] = [
    { key: "persons",   label: t("persons"),   items: persons },
    { key: "orgs",      label: t("orgs"),      items: orgs },
    { key: "locations", label: t("locations"), items: locations },
    { key: "events",    label: t("events"),    items: events },
    { key: "markets",   label: t("markets"),   items: markets },
    { key: "products",  label: t("products"),  items: products },
  ];

  return (
    <div className="space-y-3">
      {sections.map(({ key, label, items }) =>
        items.length > 0 ? (
          <div key={key}>
            <SubLabel>{label}</SubLabel>
            <ChipRow items={items} />
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * Story-level entities block — aggregates from the cluster's articles
 * with the ≥2-articles threshold and top-10 cap, then renders. Skips
 * itself entirely when nothing meets the threshold.
 */
export function StoryEntitiesBlock({ articles }: { articles: Article[] }) {
  const agg = aggregateStoryEntities(articles);
  return (
    <EntitiesBlock
      persons={agg.persons}
      orgs={agg.orgs}
      locations={agg.locations}
      events={agg.events}
      markets={agg.markets}
      products={agg.products}
    />
  );
}

/**
 * Article-level entities block — straight from `article.entities`
 * (a flat LinkedEntity[]). Each entity renders without
 * a count. Groups the flat list by kind for the section rendering.
 */
export function ArticleEntitiesBlock({
  entities,
}: {
  entities: LinkedEntity[] | null | undefined;
}) {
  const list = entities ?? [];
  const byKind = (kind: LinkedEntity["kind"]): EntityList =>
    list.filter((e) => e.kind === kind).map((e) => ({ label: e.name }));
  return (
    <EntitiesBlock
      persons   = {byKind("person")}
      orgs      = {byKind("org")}
      locations = {byKind("location")}
      events    = {byKind("event")}
      markets   = {byKind("market")}
      products  = {byKind("product")}
    />
  );
}

/**
 * Country chip row. Resolves codes to localized names via `countryLabel`
 * (already handles EU and regional pseudo-codes). When `withCounts` is
 * true, items render as `France · 4`; otherwise just `France`.
 */
function CountriesRow({
  items,
}: {
  items: RankedItem[] | string[];
}) {
  const locale = useLocale();
  const normalized: { label: string; count?: number }[] = items.map((it) =>
    typeof it === "string"
      ? { label: countryLabel(it, locale) || it }
      : { label: countryLabel(it.label, locale) || it.label, count: it.count },
  );
  return <ChipRow items={normalized} />;
}

/**
 * Story-level countries block — aggregated with the same threshold rule
 * as entities. Returns null when nothing qualifies.
 */
export function StoryCountriesBlock({ articles }: { articles: Article[] }) {
  const ranked = aggregateStoryCountries(articles);
  if (ranked.length === 0) return null;
  return <CountriesRow items={ranked} />;
}

/**
 * Article-level countries block — raw `article.countries` without
 * aggregation.
 */
export function ArticleCountriesBlock({ countries }: { countries: string[] | null | undefined }) {
  const list = (countries ?? []).filter(Boolean);
  if (list.length === 0) return null;
  return <CountriesRow items={list} />;
}

/**
 * Bottom info strip for the cluster detail — "7 articles · active ·
 * started 3d ago". Each segment is independent: missing parts collapse,
 * separators only render between visible segments.
 */
export function StoryInfoStrip({
  nArticles,
  status,
  startedAt,
}: {
  nArticles: number;
  status?: "active" | "closed" | null;
  startedAt: string | null;
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const age = relativeAge(startedAt, locale);
  const segments: string[] = [];
  segments.push(t("nArticles", { count: nArticles }));
  if (status === "active") segments.push(t("statusActive"));
  else if (status === "closed") segments.push(t("statusClosed"));
  if (age) segments.push(t("startedAge", { age }));
  return (
    <div className="text-[11.5px] text-text-3 font-mono tracking-[0.02em] tabular-nums">
      {segments.join(" · ")}
    </div>
  );
}
