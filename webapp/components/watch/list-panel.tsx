"use client";

import * as React from "react";
import { Check, Eye, Loader2, Pencil, SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchInput } from "@/components/ui/search-input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLastWorkerCheck } from "@/lib/realtime/use-last-worker-check";
import { ClusterCard } from "./cluster-card";
import { NewArticlesPill } from "./new-articles-pill";
import { SingletonRow } from "./singleton-row";
import { FiltersDialog } from "./filters-dialog";
import { MarkAllReadButton } from "./mark-all-read-button";
import { PeriodSelector } from "./period-selector";
import { cn } from "@/lib/utils";
import {
  countAdvanced,
  describeScope,
  type Advanced,
  type Scope,
  type StoryType,
} from "@/lib/filter";
import { fmtSmartClock, latestFetched } from "@/lib/format";
import type { Aggregations } from "@/lib/aggregate";
import type { View, Story, Singleton, UserState, WatchData } from "@/lib/types";

function mergeUserState(
  base: UserState | null | undefined,
  override: Partial<UserState> | undefined,
): UserState | null {
  if (!base) return null;
  return override ? { ...base, ...override } : base;
}

/** Row shape that flows through the virtualized feed. Stories and
 *  singletons share the same vertical scroll, distinguished by `kind`. */
type FeedItem =
  | { kind: "story"; data: Story; ts: string }
  | { kind: "singleton"; data: Singleton; ts: string };

/** Cluster recency = latest article timestamp. Drives sort in the "Tout"
 *  tab where stories and singletons interleave. ISO strings compare
 *  lexicographically, so no need to parse to Date. */
function latestArticleTs(story: Story): string {
  let max = "";
  for (const a of story.articles) {
    const ts = a.published_at || a.fetched_at || "";
    if (ts > max) max = ts;
  }
  return max;
}

export function ListPanel({
  data,
  aggs,
  filteredStories,
  filteredSingletons,
  scope,
  advanced,
  onAdvancedChange,
  userPrefs,
  currentView = null,
  onEditView,
  storyType,
  onStoryTypeChange,
  activeStoryId,
  activeArticleId,
  onToggle,
  onSave,
  onUnsave,
  onFollow,
  onUnfollow,
  onIgnored,
  onUnignored,
  onOpenFolders,
  onMarkAllRead,
  unreadCount,
  viewIgnored,
  locallyRead,
  overrides,
  consumedArticles,
  onArticleConsume,
  onArticlePreview,
  onLoadMore,
  hasMore,
  isLoadingMore,
  scopeCounts,
  periodHours,
  onPeriodHoursChange,
}: {
  data: WatchData;
  aggs: Aggregations;
  filteredStories: Story[];
  filteredSingletons: Singleton[];
  scope: Scope;
  advanced: Advanced;
  onAdvancedChange: (next: Advanced) => void;
  /** User's persistent default filters. Surfaces a "Restore my
   *  preferences" button inside FiltersDialog so the user can snap
   *  back to their baseline without leaving the dialog. */
  userPrefs?: Advanced;
  /** Active saved view, if any. When non-null, the header swaps the Filtres
   *  button for a "Modifier la vue" button instead. */
  currentView?: View | null;
  onEditView?: () => void;
  storyType: StoryType;
  onStoryTypeChange: (next: StoryType) => void;
  activeStoryId: number | null;
  /** Drives the visual highlight on the clicked-for-preview article row. */
  activeArticleId?: number | null;
  onToggle: (storyId: number) => void;
  onSave?: (storyId: number) => void;
  onUnsave?: (storyId: number) => void;
  onFollow?: (storyId: number) => void;
  onUnfollow?: (storyId: number) => void;
  onIgnored?: (storyId: number) => void;
  onUnignored?: (storyId: number) => void;
  /** Opens the FolderPickerDialog for a given story (delegated by RowActions). */
  onOpenFolders?: (storyId: number) => void;
  /** Owner-only. Marks every loaded story read ("fresh start"). Undefined
   *  for non-owners → the button isn't rendered. */
  onMarkAllRead?: () => void;
  /** Truly-unread total across the loaded watch — disables the mark-all
   *  button at 0 and feeds the confirmation copy. */
  /** null = "count not known yet" (= server aggs in flight). The
   *  consuming "Tout marquer comme lu" button treats null/0 the same:
   *  disable the action and show no number on the confirmation copy. */
  unreadCount?: number | null;
  viewIgnored?: boolean;
  locallyRead?: Set<number>;
  overrides?: Map<number, Partial<UserState>>;
  /** Article IDs the user already "consumed" this session (clicked, or
   *  closed their cluster). Drives the per-row blue dot in the expand. */
  consumedArticles?: Set<number>;
  /** Fires on every article click — plain or modifier — so the parent
   *  records consumption regardless of how the user opens the link. */
  onArticleConsume?: (articleId: number) => void;
  /** Fires only on a plain click (no Cmd/Ctrl/Shift). Parent shows the
   *  article in the detail panel instead of letting the browser open
   *  the URL. Modifier clicks still open the link in a new tab. */
  onArticlePreview?: (articleId: number) => void;
  /** Pagination. Triggered by the virtualized feed when
   *  the user scrolls within a few rows of the bottom AND `hasMore` is
   *  true AND a fetch isn't already in flight. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  /** Server-side counts for the story-type tabs (Tous / Communs /
   *  Originaux). When set, the tab badges display these numbers instead
   *  of the loaded-pages length, which would grow as the user scrolls.
   *  Undefined while the /watch/aggregations hook hasn't returned yet
   *  (= the tabs render without a number). */
  scopeCounts?: { all: number; common: number; original: number };
  /** Global period selector value. Applies to the story list AND the
   *  per-view badges in the sidebar: this is the one knob that gates
   *  every time-filtered surface in /watch. */
  periodHours:         number;
  onPeriodHoursChange: (hours: number) => void;
}) {
  const t = useTranslations("list");
  const locale = useLocale();
  const activeScope = describeScope(scope, aggs, locale);
  const advancedCount = countAdvanced(advanced);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  // Three anchor states: main view / scope / saved view. The header swaps
  // its right-side button accordingly:
  //   - main view  → "Filtres" (opens FiltersDialog for ad-hoc advanced)
  //   - scope      → nothing (scope is a single-pick, nothing to "edit")
  //   - saved view → "Modifier" (opens ViewEditDialog on the active view)
  const isMainView = scope.kind === "none" && currentView === null;
  const isSavedViewActive = currentView !== null;
  const isAdvancedActive = advancedCount > 0;

  const showClusters = storyType !== "originaux";
  const showSingletons = storyType !== "communs";

  // Memoised: the empty-array branches allocate a new array each
  // render, which would rebuild the virtualised row list every time.
  const stories = React.useMemo(
    () => (showClusters ? filteredStories : []),
    [showClusters, filteredStories],
  );
  const singletons = React.useMemo(
    () => (showSingletons ? filteredSingletons : []),
    [showSingletons, filteredSingletons],
  );
  const total = stories.length + singletons.length;
  const isEmpty = total === 0;

  /**
   * "Tout" tab → interleave clusters and singletons sorted by recency DESC,
   * so a hot singleton can outrank a stale cluster regardless of how many
   * sources cover the cluster. The cluster's recency = the latest article
   * timestamp in it (already DESC-sorted by the API) — so it bubbles up
   * the moment a fresh article attaches.
   *
   * "Communs" / "Originaux" tabs → keep the type-specific list, no merge.
   */
  const items: FeedItem[] = React.useMemo(() => {
    if (storyType === "communs") {
      return stories.map((s) => ({
        kind: "story" as const,
        data: s,
        ts: latestArticleTs(s),
      }));
    }
    if (storyType === "originaux") {
      return singletons.map((a) => ({
        kind: "singleton" as const,
        data: a,
        ts: a.published_at || a.fetched_at || "",
      }));
    }
    // "all" — merge by recency DESC
    const merged: FeedItem[] = [
      ...stories.map((s) => ({
        kind: "story" as const,
        data: s,
        ts: latestArticleTs(s),
      })),
      ...singletons.map((a) => ({
        kind: "singleton" as const,
        data: a,
        ts: a.published_at || a.fetched_at || "",
      })),
    ];
    merged.sort((x, y) => y.ts.localeCompare(x.ts));
    return merged;
  }, [stories, singletons, storyType]);

  /* Tab counters (Tous / Communs / Originaux).
   * `scopeCounts` is the server-side authority (= reflects the full
   * universe matching the active filter set). When undefined, we DO NOT
   * fall back to `filteredStories.length` — that number would only count
   * the loaded pages and would lie ("50" while the user sees a 524-story
   * universe). Instead the counters render with a null/undefined value
   * and the UI shows them without a number until the truth arrives.
   *
   * In practice the SSR embed in /watch (`watch_aggs`) already populates
   * `scopeCounts` on the first paint via `useWatchAggs.initialData`, so
   * this null window only ever shows up briefly (= during a filter
   * change refetch, with stale-while-revalidate keeping the prior
   * values stable). */
  const counts: { all: number | null; communs: number | null; originaux: number | null } =
    scopeCounts
      ? {
          all:       scopeCounts.all,
          communs:   scopeCounts.common,
          originaux: scopeCounts.original,
        }
      : {
          all:       null,
          communs:   null,
          originaux: null,
        };

  const setQuery = (q: string) => onAdvancedChange({ ...advanced, query: q });

  /** Last-updated indicator — semantics: "the worker just checked your
   *  feeds at HH:MM", not "your latest article is from HH:MM". Driven
   *  by the worker's heartbeat broadcast, so the indicator
   *  ticks even on passes that collected zero new content — the user
   *  sees the system is alive. Falls back to the latest fetched_at in
   *  the loaded data until the first heartbeat lands (≤ 5 min after
   *  page open). */
  const fallbackIso = React.useMemo(() => {
    return latestFetched([
      ...data.stories.flatMap((s) => s.articles),
      ...data.singletons,
    ]);
  }, [data.stories, data.singletons]);
  const lastUpdatedIso = useLastWorkerCheck(fallbackIso);
  const lastUpdatedLabel = lastUpdatedIso
    ? fmtSmartClock(lastUpdatedIso, locale)
    : null;

  const isFilteredFromTotal =
    filteredStories.length + filteredSingletons.length <
    data.stories.length + data.singletons.length;

  return (
    <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg border-r border-border">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-bg border-b border-border">
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
          <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-text shrink-0">
            {t("stories")}
          </h2>
          {activeScope && (
            <>
              <span className="text-text-4 shrink-0">·</span>
              <span className="text-[12px] truncate min-w-0">
                <span className="text-text-3">{activeScope.kind}</span>
                <span className="text-text-4"> : </span>
                <span className="text-text font-medium">
                  {activeScope.value}
                </span>
              </span>
            </>
          )}
          {currentView && (
            <>
              <span className="text-text-4 shrink-0">·</span>
              <span className="inline-flex items-center gap-1.5 text-[12px] truncate min-w-0">
                <Eye size={11} strokeWidth={1.7} className="text-text-3 shrink-0" />
                <span className="text-text-3">{t("viewKind")}</span>
                <span className="text-text-4"> : </span>
                <span className="text-text font-medium truncate">
                  {currentView.name}
                </span>
              </span>
            </>
          )}
          <span className="text-[11.5px] font-medium tabular-nums text-text-4 shrink-0">
            {counts.all ?? ""}
          </span>
          {lastUpdatedLabel && (
            <span
              className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-text-3 select-none shrink-0"
              title={t("lastUpdatedTooltip", { time: lastUpdatedLabel })}
            >
              <span className="block w-1.5 h-1.5 rounded-full bg-good" />
              <span>{t("lastUpdated", { time: lastUpdatedLabel })}</span>
            </span>
          )}
          <div className="flex-1" />
          <PeriodSelector
            value={periodHours}
            onChange={onPeriodHoursChange}
          />
          <SearchInput size="sm" inputClassName="w-[140px]" value={advanced.query} onChange={setQuery} />
          {isMainView && (
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              title={t("advancedFilters")}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
                "border text-[12px] font-medium cursor-pointer",
                "transition-colors duration-100",
                isAdvancedActive
                  ? "bg-text text-bg border-text shadow-sm hover:bg-text-2 hover:border-text-2"
                  : "bg-bg-elev text-text-2 border-border hover:bg-bg-hover hover:text-text",
              )}
            >
              <SlidersHorizontal size={11} strokeWidth={1.6} />
              <span>{t("filters")}</span>
              {isAdvancedActive && advancedCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-bg/20 text-bg text-[10px] font-semibold tabular-nums">
                  {advancedCount}
                </span>
              )}
            </button>
          )}
          {isSavedViewActive && onEditView && (
            <button
              type="button"
              onClick={onEditView}
              title={t("editView")}
              className="
                inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md
                border bg-bg-elev text-text-2 border-border
                hover:bg-bg-hover hover:text-text
                text-[12px] font-medium cursor-pointer
                transition-colors duration-100
              "
            >
              <Pencil size={11} strokeWidth={1.6} />
              <span>{t("editView")}</span>
            </button>
          )}
          {onMarkAllRead && (
            <MarkAllReadButton
              unreadCount={unreadCount ?? 0}
              onConfirm={onMarkAllRead}
            />
          )}
        </div>

        <Tabs
          value={storyType}
          onValueChange={(v) => onStoryTypeChange(v as StoryType)}
        >
          <TabsList className="px-3.5 h-auto bg-transparent rounded-none p-0 justify-start gap-0">
            <Tab
              value="all"
              kind="all"
              label={t("tabAll")}
              count={counts.all}
            />
            <Tab
              value="communs"
              kind="communs"
              label={t("tabCommon")}
              count={counts.communs}
              hint={t("commonHint")}
            />
            <Tab
              value="originaux"
              kind="originaux"
              label={t("tabOriginal")}
              count={counts.originaux}
              hint={t("originalHint")}
            />
          </TabsList>
        </Tabs>

        {/* "N nouveaux articles" pill — sits inside the sticky header so
         *  it stays visible while the feed scrolls. Self-hides when its
         *  internal counter is 0 (no broadcast received yet, or after the
         *  user clicked to refresh). */}
        <NewArticlesPill slug={data.slug} />
      </div>

      {/* Scroll area — virtualized.
       *  Only the visual rows roughly in/around the viewport are mounted
       *  in the DOM at any time (overscan keeps a small buffer of off-
       *  screen rows ready for scroll). The list can hold thousands of
       *  items without bloating the DOM, which keeps frame budget under
       *  control for sidebar/detail panel transitions and scroll. */}
      <VirtualizedFeed
        items={items}
        isEmpty={isEmpty}
        isFilteredFromTotal={isFilteredFromTotal}
        overrides={overrides}
        activeStoryId={activeStoryId}
        activeArticleId={activeArticleId}
        consumedArticles={consumedArticles}
        locallyRead={locallyRead}
        viewIgnored={viewIgnored}
        scope={scope}
        advanced={advanced}
        onToggle={onToggle}
        onSave={onSave}
        onUnsave={onUnsave}
        onFollow={onFollow}
        onUnfollow={onUnfollow}
        onIgnored={onIgnored}
        onUnignored={onUnignored}
        onOpenFolders={onOpenFolders}
        onArticleConsume={onArticleConsume}
        onArticlePreview={onArticlePreview}
        onLoadMore={onLoadMore}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
      />

      <FiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        advanced={advanced}
        userPrefs={userPrefs}
        aggs={aggs}
        onApply={onAdvancedChange}
      />
    </section>
  );
}

/* ─────────── Sub-components ─────────── */

/**
 * Virtualized scroll container for the feed.
 *
 * Built on @tanstack/react-virtual. Only the rows in (or near) the
 * viewport are mounted in the DOM at any time — typically ~20 nodes —
 * even when the underlying list has hundreds. This keeps the DOM small
 * enough that the sidebar/detail-panel width animations stay smooth and
 * the initial paint stays under control.
 *
 * Item heights are variable (a cluster card expands taller when active,
 * a singleton row is short, an expanded cluster with many articles is
 * tall). The virtualizer uses `measureElement` to read each rendered
 * row's actual height via ResizeObserver and recompute offsets on the
 * fly — no manual sizing needed.
 *
 * A note on the wrapper structure: the outer ref'd div is the scroll
 * container (must have a bounded height), the inner spacer div has
 * `height = total measured size` so the native scrollbar reflects the
 * full list length, and each virtual row is absolutely positioned via
 * `translateY` to its computed offset. This is the canonical TanStack
 * pattern — don't try to "flexbox + gap" your way out of it.
 */
function VirtualizedFeed({
  items,
  isEmpty,
  isFilteredFromTotal,
  overrides,
  activeStoryId,
  activeArticleId,
  consumedArticles,
  locallyRead,
  viewIgnored,
  scope,
  advanced,
  onToggle,
  onSave,
  onUnsave,
  onFollow,
  onUnfollow,
  onIgnored,
  onUnignored,
  onOpenFolders,
  onArticleConsume,
  onArticlePreview,
  onLoadMore,
  hasMore,
  isLoadingMore,
}: {
  items: FeedItem[];
  isEmpty: boolean;
  isFilteredFromTotal: boolean;
  overrides?: Map<number, Partial<UserState>>;
  activeStoryId: number | null;
  activeArticleId?: number | null;
  consumedArticles?: Set<number>;
  locallyRead?: Set<number>;
  viewIgnored?: boolean;
  scope: Scope;
  advanced: Advanced;
  onToggle: (storyId: number) => void;
  onSave?: (storyId: number) => void;
  onUnsave?: (storyId: number) => void;
  onFollow?: (storyId: number) => void;
  onUnfollow?: (storyId: number) => void;
  onIgnored?: (storyId: number) => void;
  onUnignored?: (storyId: number) => void;
  onOpenFolders?: (storyId: number) => void;
  onArticleConsume?: (articleId: number) => void;
  onArticlePreview?: (articleId: number) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}) {
  const t = useTranslations("list");
  const parentRef = React.useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // Reasonable first guess so the scroll bar isn't wildly off before
    // measurements kick in. Real heights replace this row-by-row via
    // measureElement on first paint of each item.
    estimateSize: () => 128,
    // Render a few rows above/below the viewport so a quick scroll
    // doesn't reveal blank space before the next render commits.
    overscan: 6,
    // A stable key keeps the virtualizer's measurement cache attached
    // to the right item even when the list reorders (e.g. when a fresh
    // article bumps a cluster's recency).
    getItemKey: (idx) => {
      const item = items[idx];
      return item.kind === "story"
        ? `s-${item.data.articles[0]?.story_id ?? idx}`
        : `a-${item.data.id}`;
    },
  });

  const virtualRows = virtualizer.getVirtualItems();

  /* ── Infinite scroll trigger ──
   *
   * Fire `onLoadMore` when the LAST virtual item being rendered is
   * within 5 rows of the end of the loaded items. With overscan=6 the
   * virtualizer already keeps a buffer below the viewport, so this
   * pre-fetches the next page about half a screen before the user hits
   * the actual bottom — keeps scroll feeling continuous.
   *
   * Guards: skip if no `onLoadMore` provided, if `hasMore` is false
   * (= server told us the stream is exhausted), or if a fetch is
   * already in flight (`isLoadingMore` true). All three checks are
   * cheap and idempotent — the effect runs on every virtual-row
   * change, which is exactly when "am I close to the bottom?" might
   * have flipped from false → true.
   */
  React.useEffect(() => {
    if (!onLoadMore || !hasMore || isLoadingMore) return;
    if (virtualRows.length === 0) return;
    const last = virtualRows[virtualRows.length - 1];
    if (last.index >= items.length - 5) {
      onLoadMore();
    }
  }, [virtualRows, items.length, onLoadMore, hasMore, isLoadingMore]);

  if (isEmpty) {
    // Pagination tab-change in flight: the previous page
    // was wiped, the new server type is loading. Show a centered
    // spinner instead of EmptyState so the user understands content
    // is COMING (vs "nothing to show under your current filters").
    if (isLoadingMore) {
      return (
        <div className="flex-1 overflow-y-auto min-h-0 flex items-center justify-center">
          <Loader2
            size={20}
            strokeWidth={1.6}
            className="animate-spin text-text-3"
          />
        </div>
      );
    }
    return (
      <div className="flex-1 overflow-y-auto min-h-0">
        <EmptyState filtered={isFilteredFromTotal} />
      </div>
    );
  }

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto min-h-0">
      <div className="max-w-[880px] mx-auto px-3 pt-3 pb-12">
        <div
          // Spacer that matches the total measured height of the list.
          // Native scrollbar sizes itself against this, which gives the
          // user the right "feel" of how far they are in the feed.
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          {virtualRows.map((vr) => {
            const item = items[vr.index];
            const storyId =
              item.kind === "story"
                ? (item.data.articles[0]?.story_id ?? -vr.index)
                : item.data.story_id;
            return (
              <div
                key={vr.key}
                data-index={vr.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vr.start}px)`,
                  // Visual gap between rows. paddingBottom is on every
                  // row so the last row also gets bottom breathing room
                  // before the container's pb-12.
                  paddingBottom: "8px",
                }}
              >
                {item.kind === "story" ? (
                  (() => {
                    const merged: Story = {
                      ...item.data,
                      user_state: mergeUserState(
                        item.data.user_state,
                        overrides?.get(storyId),
                      ),
                    };
                    return (
                      <ClusterCard
                        story={merged}
                        active={activeStoryId === storyId}
                        onToggle={() => onToggle(storyId)}
                        onSave={onSave}
                        onUnsave={onUnsave}
                        onFollow={onFollow}
                        onUnfollow={onUnfollow}
                        onIgnored={onIgnored}
                        onUnignored={onUnignored}
                        onOpenFolders={onOpenFolders}
                        viewIgnored={viewIgnored}
                        locallyRead={locallyRead?.has(storyId) ?? false}
                        consumedArticles={consumedArticles}
                        activeArticleId={activeArticleId ?? null}
                        onArticleConsume={onArticleConsume}
                        onArticlePreview={onArticlePreview}
                        scope={scope}
                        advanced={advanced}
                      />
                    );
                  })()
                ) : (
                  (() => {
                    const merged: Singleton = {
                      ...item.data,
                      user_state: mergeUserState(
                        item.data.user_state,
                        overrides?.get(item.data.story_id),
                      ),
                    };
                    return (
                      <SingletonRow
                        article={merged}
                        // Standalone singletons carry `story_id = null`.
                        // Without the explicit null guard, `activeStoryId
                        // === item.data.story_id` becomes `null === null`
                        // when no story is open, lighting up the "active"
                        // marker on every standalone singleton at once.
                        active={
                          item.data.story_id != null
                          && activeStoryId === item.data.story_id
                        }
                        onToggle={() => onToggle(item.data.story_id)}
                        onSave={onSave}
                        onUnsave={onUnsave}
                        onFollow={onFollow}
                        onUnfollow={onUnfollow}
                        onIgnored={onIgnored}
                        onUnignored={onUnignored}
                        onOpenFolders={onOpenFolders}
                        viewIgnored={viewIgnored}
                        locallyRead={locallyRead?.has(item.data.story_id) ?? false}
                      />
                    );
                  })()
                )}
              </div>
            );
          })}
        </div>

        {/* Pagination footer:
         *   - isLoadingMore  → spinner alone, no text. Sits below the last item, fades in
         *     while the next page is fetched.
         *   - !hasMore       → "all caught up" with a check icon —
         *     definitive end-of-stream signal. Subtle muted styling so
         *     it doesn't compete with the content above. */}
        {isLoadingMore && (
          <div className="flex items-center justify-center py-6">
            <Loader2
              size={16}
              strokeWidth={1.6}
              className="animate-spin text-text-3"
            />
          </div>
        )}
        {!isLoadingMore && hasMore === false && (
          <div className="flex items-center justify-center gap-2 py-8 text-text-3 text-xs">
            <Check size={12} strokeWidth={1.8} />
            <span>{t("allCaughtUp")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({
  value,
  label,
  count,
  hint,
}: {
  value: string;
  kind: "all" | "communs" | "originaux";
  label: string;
  /** `null` means "count not known yet" (= server aggs in flight). The
   *  Tab renders without a count number rather than showing a misleading
   *  loaded-pages-only number. See `counts` in ListPanel for context. */
  count: number | null;
  hint?: string;
}) {
  return (
    <TabsTrigger
      value={value}
      title={hint}
      className={cn(
        "inline-flex items-center gap-1.5",
        "px-2.5 py-2 rounded-none",
        "text-[12px] font-medium text-text-3",
        "border-b-2 border-transparent bg-transparent shadow-none",
        "transition-colors duration-100",
        "hover:text-text-2",
        "data-[state=active]:text-text data-[state=active]:font-semibold data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-text",
      )}
    >
      <span>{label}</span>
      {count !== null && (
        <span className="text-[10.5px] tabular-nums text-text-4">{count}</span>
      )}
    </TabsTrigger>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  const t = useTranslations("list");
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-[380px] space-y-2">
        <p className="text-[13px] text-text-2">
          {filtered ? t("noResultsFiltered") : t("noResultsWindow")}
        </p>
        <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-text-4">
          {filtered ? t("resetToShowAll") : t("tryAgainLater")}
        </p>
      </div>
    </div>
  );
}
