"use client";

import * as React from "react";
import {
  Bookmark,
  Building2,
  CalendarDays,
  ChevronRight,
  Earth,
  Eye,
  Flag,
  Globe,
  Hash,
  LineChart,
  MapPin,
  Package,
  Plus,
  Rss,
  Trash2,
  TrendingUp,
  User,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { SidebarLevel } from "@/components/app/sidebar-level";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  EMPTY_UNREAD_COUNTS,
  entityKey,
  type Aggregations,
  type UnreadCounts,
} from "@/lib/aggregate";
import { type Scope } from "@/lib/filter";
import { langLabel } from "@/lib/format";
import type { View } from "@/lib/types";
import { useCategoryLabel } from "@/lib/use-category-label";

/** Basic view modes — orthogonal to scope/view/folder slot selection.
 *  Named `ViewMode` (rather than `View`) to free the `View` identifier
 *  for the user-saved-view entity imported from `@/lib/types`. */
type ViewMode = "all" | "unread" | "saved" | "top" | "ignored";

/** Scope kinds writable by the sidebar (subset of all Scope kinds — the
 *  sidebar doesn't write to scope.kind="none", which is the cleared state). */
type SidebarScopeKind = Exclude<Scope["kind"], "none">;

export function Sidebar({
  aggs,
  scope,
  onScopeChange,
  onReset,
  view = "all",
  onViewChange,
  views = [],
  currentViewId = null,
  onSelectView,
  onCreateView,
  onEditView,
  // Folders are not here: they live in the library (`/library`).
  counts,
  unreadCounts = EMPTY_UNREAD_COUNTS,
  isOwner = false,
  viewCounts,
}: {
  aggs: Aggregations;
  scope: Scope;
  onScopeChange: (next: Scope) => void;
  onReset: () => void;
  view?: ViewMode;
  onViewChange?: (next: ViewMode) => void;
  /** User's saved views (smart filters). Empty for non-owners. */
  views?: View[];
  /** Active saved-view id. Mutex with non-"none" scope at the parent level. */
  currentViewId?: string | null;
  onSelectView?: (viewId: string | null) => void;
  onCreateView?: () => void;
  onEditView?: (viewId: string) => void;
  /** Each field is `null` while the server aggregations are loading
   *  (= first paint of a cold-cache session). The NavRow consumers
   *  already treat null/undefined via `count ?? fallback` or
   *  `count || undefined`, so a null payload renders without a
   *  misleading client-side number. */
  counts?: {
    all:     number | null;
    unread:  number | null;
    saved:   number | null;
    top:     number | null;
    ignored: number | null;
  };
  /** Per-Explore-section unread badges. Each section reads its own
   *  dimension — see `UnreadCounts` in lib/aggregate.ts. */
  unreadCounts?: UnreadCounts;
  /** View rows are owner-only — disabled on someone else's watch. */
  isOwner?: boolean;
  /** Per-view item counts from /me/views/counts. Undefined while the
   *  `useViewCounts` hook is loading (= view rows render name-only).
   *  Missing keys for individual views also show no number. */
  viewCounts?: Record<string, number>;
}) {
  const t = useTranslations("sidebar");
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();
  // Sidebar = single-select exclusive. Clicking ANY facet replaces the
  // current scope (and clears the active view as a side effect, enforced
  // by the parent's setScope wrapper). Re-clicking the active row resets
  // scope + view back to "Tout".

  /** Feeds in Explore: group by country (all FR together, all US together,
   *  …). Countries sorted by total article volume desc so the most active
   *  origin lands at the top; feeds within a country also count-desc. */
  const feedsSorted = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const f of aggs.feeds) {
      const c = f.country ?? "ZZ";
      totals.set(c, (totals.get(c) ?? 0) + f.count);
    }
    return [...aggs.feeds].sort((a, b) => {
      const ca = a.country ?? "ZZ";
      const cb = b.country ?? "ZZ";
      if (ca !== cb) {
        const ta = totals.get(ca) ?? 0;
        const tb = totals.get(cb) ?? 0;
        if (tb !== ta) return tb - ta;
        return ca.localeCompare(cb);
      }
      return b.count - a.count;
    });
  }, [aggs.feeds]);

  const select = React.useCallback(
    (kind: SidebarScopeKind, value: string | number) => {
      // Re-clicking the active facet clears scope + view back to default.
      if (scope.kind === kind && scope.value === value) {
        onReset();
      } else {
        onScopeChange({ kind, value } as Scope);
      }
    },
    [scope, onScopeChange, onReset],
  );

  // "All" lights up only when there's NO active anchor (no scope, no
  // saved view) AND no view mode selected. Otherwise we'd double-
  // highlight (e.g. while in a saved view with view="all", scope is
  // none too, which would otherwise read as "All is active" — wrong).
  const isAllActive =
    scope.kind === "none" &&
    currentViewId === null;

  /** Is a given (kind, value) pair the currently-active scope? */
  const isActiveScope = (kind: SidebarScopeKind, value: string | number) =>
    scope.kind === kind && scope.value === value;

  return (
    <SidebarLevel>
      <div className="flex flex-col gap-1 pt-1">
        {/* Vues */}
        <NavGroup label={t("sectionViews")}>
          <NavRow
            leading={
              <span className="block w-2 h-2 rounded-sm bg-text-3 opacity-50" />
            }
            label={t("all")}
            count={counts?.all ?? undefined}
            active={isAllActive && view === "all"}
            onClick={onReset}
          />
          <NavRow
            leading={<span className="block w-2 h-2 rounded-full bg-new" />}
            label={t("unread")}
            count={counts?.unread || undefined}
            active={view === "unread"}
            disabled={!isOwner}
            title={
              !isOwner
                ? t("signInToFilterUnread")
                : view === "unread"
                  ? t("backToNormal")
                  : t("viewUnread")
            }
            onClick={() =>
              onViewChange?.(view === "unread" ? "all" : "unread")
            }
          />
          <NavRow
            leading={<Bookmark size={11} strokeWidth={1.6} />}
            label={t("saved")}
            count={counts?.saved || undefined}
            active={view === "saved"}
            disabled={!isOwner || ((counts?.saved ?? 0) === 0 && view !== "saved")}
            title={
              !isOwner
                ? t("signInToFilterSaved")
                : (counts?.saved ?? 0) === 0
                  ? t("noSavedYet")
                  : view === "saved"
                    ? t("backToNormal")
                    : t("viewSaved")
            }
            onClick={() =>
              onViewChange?.(view === "saved" ? "all" : "saved")
            }
          />
          <NavRow
            leading={<TrendingUp size={11} strokeWidth={1.6} />}
            label={t("topStories")}
            count={counts?.top || undefined}
            active={view === "top"}
            disabled={!isOwner || ((counts?.top ?? 0) === 0 && view !== "top")}
            title={
              !isOwner
                ? t("signInToFilterTop")
                : (counts?.top ?? 0) === 0
                  ? t("noTopYet")
                  : view === "top"
                    ? t("backToNormal")
                    : t("viewTopStories")
            }
            onClick={() => onViewChange?.(view === "top" ? "all" : "top")}
          />
          <NavRow
            leading={<Trash2 size={11} strokeWidth={1.6} />}
            label={t("ignored")}
            count={counts?.ignored || undefined}
            active={view === "ignored"}
            disabled={!isOwner || ((counts?.ignored ?? 0) === 0 && view !== "ignored")}
            title={
              !isOwner
                ? t("signInToViewIgnored")
                : (counts?.ignored ?? 0) === 0
                  ? t("noIgnoredYet")
                  : view === "ignored"
                    ? t("backToNormal")
                    : t("viewIgnoredAction")
            }
            onClick={() =>
              onViewChange?.(view === "ignored" ? "all" : "ignored")
            }
          />
        </NavGroup>

        {/* Mes vues — the user's saved smart-filter sets. */}
        <ViewsSection
          views={views}
          currentViewId={currentViewId}
          isOwner={isOwner}
          onSelectView={onSelectView}
          onCreateView={onCreateView}
          onEditView={onEditView}
          headerLabel={t("sectionMyViews")}
          createLabel={t("newView")}
          emptyLabel={t("noViewsYet")}
          editLabel={t("editView")}
          viewCounts={viewCounts}
        />

        {/* Folders live in the library (`/library`). The Watch sidebar
         *  only filters the current feed — no permanent collections
         *  live here. */}

        {/* Explorer — order: Feeds, Langues, Origine, Sujets, Personnes, Organisations, Lieux */}
        <SidebarSection label={t("sectionExplore")}>
        {aggs.feeds.length > 0 && (
          <SidebarCollapsible
            label={t("feeds")}
            leading={<Rss size={11} strokeWidth={1.6} />}
            count={aggs.total.feeds}
          >
            {feedsSorted.map((f) => (
              <FeedRow
                key={f.name}
                name={f.name}
                countryCode={f.country}
                count={f.count}
                unreadCount={unreadCounts.feeds[f.name]}
                active={isActiveScope("feed", f.name)}
                onClick={() => select("feed", f.name)}
              />
            ))}
          </SidebarCollapsible>
        )}

        {aggs.langs.length > 0 && (
          <SidebarCollapsible
            label={t("languages")}
            leading={<Globe size={11} strokeWidth={1.6} />}
            count={aggs.langs.length}
            defaultOpen={scope.kind === "lang"}
          >
            {aggs.langs.map((l) => {
              const active = isActiveScope("lang", l.code);
              const labelText = langLabel(l.code, locale);
              return (
                <EntityRow
                  key={l.code}
                  name={labelText}
                  count={l.count}
                  unreadCount={unreadCounts.langs[l.code]}
                  active={active}
                  onClick={() => select("lang", l.code)}
                  leading={
                    <span className="shrink-0 w-6 text-center text-[9.5px] font-bold tracking-[0.04em] text-text-3 bg-bg-elev border border-border rounded-[3px] py-px font-mono">
                      {l.code.toUpperCase()}
                    </span>
                  }
                />
              );
            })}
          </SidebarCollapsible>
        )}

        {aggs.originByRegion.length > 0 && (
          <SidebarCollapsible
            label={t("origin")}
            leading={<Flag size={11} strokeWidth={1.6} />}
            count={aggs.originByRegion.reduce((s, r) => s + r.countries.length, 0)}
          >
            {aggs.originByRegion.map((r, i) => {
              const hasActive =
                scope.kind === "country" &&
                r.countries.some((c) => c.code === scope.value);
              return (
                <SidebarCollapsible
                  key={r.region}
                  label={r.region}
                  count={r.total}
                  defaultOpen={hasActive || i === 0}
                >
                  {r.countries.map((c) => (
                    <EntityRow
                      key={c.code}
                      name={c.label}
                      count={c.count}
                      unreadCount={unreadCounts.origin[c.code]}
                      active={isActiveScope("country", c.code)}
                      onClick={() => select("country", c.code)}
                    />
                  ))}
                </SidebarCollapsible>
              );
            })}
          </SidebarCollapsible>
        )}

        {aggs.subjectCountriesByRegion.length > 0 && (
          <SidebarCollapsible
            label={t("subjectCountries")}
            leading={<Earth size={11} strokeWidth={1.6} />}
            count={aggs.subjectCountriesByRegion.reduce(
              (s, r) => s + r.countries.length,
              0,
            )}
          >
            {aggs.subjectCountriesByRegion.map((r, i) => {
              const hasActive =
                scope.kind === "subject_country" &&
                r.countries.some((c) => c.code === scope.value);
              return (
                <SidebarCollapsible
                  key={r.region}
                  label={r.region}
                  count={r.total}
                  defaultOpen={hasActive || i === 0}
                >
                  {r.countries.map((c) => (
                    <EntityRow
                      key={c.code}
                      name={c.label}
                      count={c.count}
                      unreadCount={unreadCounts.subject[c.code]}
                      active={isActiveScope("subject_country", c.code)}
                      onClick={() => select("subject_country", c.code)}
                    />
                  ))}
                </SidebarCollapsible>
              );
            })}
          </SidebarCollapsible>
        )}

        {aggs.categories.length > 0 && (
          <SidebarCollapsible
            label={t("topics")}
            leading={<Hash size={11} strokeWidth={1.6} />}
            count={aggs.categories.length}
          >
            {aggs.categories.slice(0, 20).map((c) => (
              <EntityRow
                key={c.name}
                name={categoryLabel(c.name)}
                count={c.count}
                unreadCount={unreadCounts.categories[c.name]}
                active={isActiveScope("category", c.name)}
                onClick={() => select("category", c.name)}
                leading={<Hash size={11} strokeWidth={1.6} />}
              />
            ))}
          </SidebarCollapsible>
        )}

        {aggs.entities.persons.length > 0 && (
          <SidebarCollapsible
            label={t("persons")}
            leading={<User size={11} strokeWidth={1.6} />}
            count={aggs.entities.persons.length}
          >
            {aggs.entities.persons.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.persons[entityKey(e.entity_id)]}
                active={isActiveScope("person", e.entity_id)}
                onClick={() => select("person", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        {aggs.entities.orgs.length > 0 && (
          <SidebarCollapsible
            label={t("organizations")}
            leading={<Building2 size={11} strokeWidth={1.6} />}
            count={aggs.entities.orgs.length}
          >
            {aggs.entities.orgs.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.orgs[entityKey(e.entity_id)]}
                active={isActiveScope("org", e.entity_id)}
                onClick={() => select("org", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        {aggs.entities.locations.length > 0 && (
          <SidebarCollapsible
            label={t("places")}
            leading={<MapPin size={11} strokeWidth={1.6} />}
            count={aggs.entities.locations.length}
          >
            {aggs.entities.locations.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.locations[entityKey(e.entity_id)]}
                active={isActiveScope("place", e.entity_id)}
                onClick={() => select("place", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        {aggs.entities.events.length > 0 && (
          <SidebarCollapsible
            label={t("events")}
            leading={<CalendarDays size={11} strokeWidth={1.6} />}
            count={aggs.entities.events.length}
          >
            {aggs.entities.events.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.events[entityKey(e.entity_id)]}
                active={isActiveScope("event", e.entity_id)}
                onClick={() => select("event", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        {aggs.entities.markets.length > 0 && (
          <SidebarCollapsible
            label={t("markets")}
            leading={<LineChart size={11} strokeWidth={1.6} />}
            count={aggs.entities.markets.length}
          >
            {aggs.entities.markets.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.markets[entityKey(e.entity_id)]}
                active={isActiveScope("market", e.entity_id)}
                onClick={() => select("market", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        {aggs.entities.products.length > 0 && (
          <SidebarCollapsible
            label={t("products")}
            leading={<Package size={11} strokeWidth={1.6} />}
            count={aggs.entities.products.length}
          >
            {aggs.entities.products.slice(0, 20).map((e) => (
              <EntityRow
                key={e.entity_id}
                name={e.name}
                count={e.count}
                unreadCount={unreadCounts.products[entityKey(e.entity_id)]}
                active={isActiveScope("product", e.entity_id)}
                onClick={() => select("product", e.entity_id)}
              />
            ))}
          </SidebarCollapsible>
        )}
        </SidebarSection>

      </div>
    </SidebarLevel>
  );
}

/* ─────────── Saved-views section ─────────── */

function ViewsSection({
  views,
  currentViewId,
  isOwner,
  onSelectView,
  onCreateView,
  onEditView,
  headerLabel,
  createLabel,
  emptyLabel,
  editLabel,
  viewCounts,
}: {
  views: View[];
  currentViewId: string | null;
  isOwner: boolean;
  onSelectView?: (viewId: string | null) => void;
  onCreateView?: () => void;
  onEditView?: (viewId: string) => void;
  headerLabel: string;
  createLabel: string;
  emptyLabel: string;
  editLabel: string;
  /** Per-view item counts from /me/views/counts. `undefined` while the
   *  hook is loading (= sidebar shows view names without numbers).
   *  Missing keys for individual views also show no number — never lie. */
  viewCounts?: Record<string, number>;
}) {
  return (
    <div className="mb-2">
      <div className="px-3 pt-1.5 pb-1 flex items-center gap-1">
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {headerLabel}
        </span>
        {isOwner && onCreateView && (
          <button
            type="button"
            onClick={onCreateView}
            title={createLabel}
            aria-label={createLabel}
            className="
              inline-flex items-center justify-center
              w-5 h-5 rounded-md shrink-0
              text-text-3 hover:text-text hover:bg-bg-hover
              transition-colors cursor-pointer
            "
          >
            <Plus size={12} strokeWidth={1.8} />
          </button>
        )}
      </div>

      {views.length === 0 ? (
        <div className="px-3 py-1 text-[11.5px] text-text-4 italic">
          {emptyLabel}
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {views.map((v) => {
            const active = v.id === currentViewId;
            return (
              <div
                key={v.id}
                className={cn(
                  "group/view flex items-center gap-2.5 mx-1",
                  "px-2.5 py-[5px] rounded-md",
                  "text-[13px] font-medium select-none",
                  "transition-colors duration-100",
                  active
                    ? "bg-bg-active text-text font-semibold"
                    : "text-text-2 hover:bg-bg-hover hover:text-text",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectView?.(active ? null : v.id)}
                  className="flex-1 min-w-0 flex items-center gap-2.5 text-left cursor-pointer"
                >
                  <Eye
                    size={11}
                    strokeWidth={1.6}
                    className={cn(
                      "shrink-0",
                      active ? "text-text" : "text-text-3",
                    )}
                  />
                  <span className="flex-1 truncate">{v.name}</span>
                  {typeof viewCounts?.[v.id] === "number" && (
                    <span
                      className={cn(
                        "text-[11.5px] tabular-nums shrink-0",
                        active ? "text-text-3" : "text-text-4",
                      )}
                    >
                      {viewCounts[v.id]}
                    </span>
                  )}
                </button>
                {onEditView && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditView(v.id);
                    }}
                    title={editLabel}
                    aria-label={editLabel}
                    className="
                      shrink-0 opacity-0 group-hover/view:opacity-100
                      inline-flex items-center justify-center
                      w-5 h-5 rounded text-text-3 hover:text-text hover:bg-bg-hover
                      transition-opacity cursor-pointer
                    "
                  >
                    <span className="text-[14px] leading-none">⋯</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────── Sub-components ─────────── */

function SidebarSection({
  label,
  children,
}: {
  label?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      {label && (
        <div className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function NavGroup({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      {label && (
        <div className="px-3 pt-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {label}
        </div>
      )}
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  );
}

function NavRow({
  leading,
  label,
  count,
  unreadCount,
  active,
  disabled,
  title,
  onClick,
}: {
  leading?: React.ReactNode;
  label: string;
  count?: number;
  unreadCount?: number;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 mx-1",
        "px-2.5 py-[5px] rounded-md",
        "text-[13px] font-medium select-none",
        "transition-colors duration-100",
        active
          ? "bg-bg-active text-text font-semibold"
          : disabled
            ? "text-text-4 cursor-not-allowed"
            : "text-text-2 hover:bg-bg-hover hover:text-text cursor-pointer",
      )}
    >
      <span
        className={cn(
          "w-3.5 inline-flex justify-center shrink-0",
          disabled ? "text-text-4" : "text-text-3",
        )}
      >
        {leading}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {typeof unreadCount === "number" && unreadCount > 0 && (
        <span className="text-[10.5px] font-semibold tabular-nums text-new-text shrink-0">
          {unreadCount}
        </span>
      )}
      {typeof count === "number" && (
        <span
          className={cn(
            "text-[11.5px] tabular-nums shrink-0",
            disabled ? "text-text-4" : "text-text-3",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function SidebarCollapsible({
  label,
  leading,
  count,
  newCount,
  defaultOpen = false,
  children,
}: {
  label: string;
  leading?: React.ReactNode;
  count?: number | string;
  newCount?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mx-1">
      <CollapsibleTrigger
        className={cn(
          "group/sb w-full flex items-center gap-2 px-2 py-[5px] rounded-[5px]",
          "text-[12px] cursor-pointer select-none",
          "text-text-2 hover:bg-bg-hover",
          "transition-colors duration-100",
        )}
      >
        <ChevronRight
          size={10}
          strokeWidth={1.8}
          className="shrink-0 text-text-4 transition-transform duration-150 group-data-[panel-open]/sb:rotate-90"
        />
        {leading && (
          <span className="shrink-0 inline-flex items-center justify-center w-3.5 text-text-3 group-data-[panel-open]/sb:text-text-2">
            {leading}
          </span>
        )}
        <span className="flex-1 text-left font-medium text-text-2 group-data-[panel-open]/sb:text-text">
          {label}
        </span>
        {newCount && newCount > 0 ? (
          <span className="text-[10.5px] font-semibold tabular-nums text-new-text">
            {newCount}
          </span>
        ) : null}
        {typeof count !== "undefined" && (
          <span className="text-[10.5px] font-medium tabular-nums text-text-4 min-w-6 text-right">
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-0.5 pb-1.5 px-1 overflow-x-hidden">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EntityRow({
  name,
  count,
  unreadCount,
  active,
  onClick,
  leading,
}: {
  name: string;
  count?: number;
  unreadCount?: number;
  active?: boolean;
  onClick?: () => void;
  leading?: React.ReactNode;
}) {
  const isClickable = !!onClick;
  const Comp = isClickable ? "button" : "div";
  return (
    <Comp
      type={isClickable ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "w-full flex items-baseline gap-2",
        "py-[3px] px-3",
        "rounded-[4px]",
        "text-[12px] leading-[1.3]",
        "transition-colors duration-100",
        leading ? "pl-3.5" : "pl-[26px]",
        active
          ? "bg-accent-soft"
          : isClickable
            ? "hover:bg-bg-hover cursor-pointer"
            : "",
      )}
    >
      {leading}
      <span
        className={cn(
          "flex-1 text-left truncate",
          active ? "text-accent-text font-semibold" : "text-text-2",
        )}
      >
        {name}
      </span>
      {typeof unreadCount === "number" && unreadCount > 0 && (
        <span className="text-[10px] font-semibold tabular-nums text-new-text shrink-0">
          {unreadCount}
        </span>
      )}
      {typeof count === "number" && (
        <span className="text-[10.5px] tabular-nums shrink-0 text-text-4">
          {count}
        </span>
      )}
    </Comp>
  );
}

function FeedRow({
  name,
  countryCode,
  count,
  unreadCount,
  active,
  onClick,
}: {
  name: string;
  countryCode: string | null;
  count: number;
  unreadCount?: number;
  active?: boolean;
  onClick?: () => void;
}) {
  const isClickable = !!onClick;
  const Comp = isClickable ? "button" : "div";
  return (
    <Comp
      type={isClickable ? "button" : undefined}
      onClick={onClick}
      title={`${name} · ${count}`}
      className={cn(
        "w-full flex items-baseline gap-2 px-3 pl-4 py-[3px] rounded-[4px]",
        "text-[11.5px] text-left",
        "transition-colors duration-100",
        active
          ? "bg-accent-soft"
          : isClickable
            ? "hover:bg-bg-hover cursor-pointer"
            : "",
      )}
    >
      <span
        className={cn(
          "flex-1 truncate",
          active ? "text-accent-text font-semibold" : "text-text-2",
        )}
      >
        {name}
      </span>
      {countryCode && (
        <span
          className={cn(
            "shrink-0 text-[9.5px] font-semibold tracking-[0.04em]",
            active ? "text-accent-text" : "text-text-4",
          )}
        >
          {countryCode.toUpperCase()}
        </span>
      )}
      {typeof unreadCount === "number" && unreadCount > 0 && (
        <span className="text-[10px] font-semibold tabular-nums text-new-text shrink-0">
          {unreadCount}
        </span>
      )}
      <span
        className={cn(
          "shrink-0 text-[10.5px] tabular-nums",
          active ? "text-accent-text" : "text-text-4",
        )}
      >
        {count}
      </span>
    </Comp>
  );
}
