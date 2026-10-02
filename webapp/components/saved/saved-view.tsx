"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { aggregate } from "@/lib/aggregate";
import {
  applyFilters,
  countAdvanced,
  emptyAdvanced,
  emptyScope,
  normalizeAdvanced,
  type Advanced,
} from "@/lib/filter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/search-input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClusterCard } from "@/components/watch/cluster-card";
import { DetailPanel } from "@/components/watch/detail-panel";
import { FiltersDialog } from "@/components/watch/filters-dialog";
import { FolderEditDialog } from "@/components/watch/folder-edit-dialog";
import { FolderPickerDialog } from "@/components/watch/folder-picker-dialog";
import { LibraryNav } from "@/components/library/library-nav";
import { ViewPicker } from "./view-picker";
import { latestPublished } from "@/lib/format";
import {
  granularityKey,
  granularityLabel,
  GRANULARITY_ORDER,
  type Granularity,
} from "@/lib/library-granularity";
import {
  addStoryToFolder,
  createFolder,
  markArticleRead,
  markStoryRead,
  removeStoryFromFolder,
  saveStory,
  unsaveStory,
} from "@/lib/actions";
import { cn } from "@/lib/utils";
import { useStoryShare } from "@/lib/use-story-share";
import type { Folder, SavedData, Story } from "@/lib/types";
import { useChanged } from "@/lib/use-changed";

/**
 * Bookmarks — every story the user saved, the first list of the library.
 *
 * Layout: header + filter bar + cards. The library's navigation
 * (Bookmarks, then the folders) goes into the app sidebar as its second
 * level. The view is always private.
 *
 * Date filtering uses adaptive buckets (today / yesterday / this week /
 * last 30d / months / years / all) over `saved_at`. Search is global
 * across all saves (title + summary, client-side); when active, the
 * bucket picker is disabled and the arrow buttons are greyed out.
 */
export function SavedView({ initialData }: { initialData: SavedData }) {
  const t = useTranslations("library");
  const tList = useTranslations("list");
  const tGran = useTranslations("granularity");
  const locale = useLocale();
  const router = useRouter();
  const allStories = initialData.stories;
  const [creatingFolder, setCreatingFolder] = React.useState(false);
  // Memoised because the `?? []` builds a new array each render, which
  // would change the identity of every callback that depends on it.
  const views = React.useMemo(
    () => initialData.views ?? [],
    [initialData.views],
  );

  /* ── Folders state (live, optimistic) ──
   * Folders are kept stateful so the picker filter and the FolderPickerDialog
   * both see fresh counts when the user adds/removes stories via the dialog.
   * Re-seeded when the server feeds fresh data via `initialData.folders` —
   * which happens on a Realtime-driven router.refresh() after the reader
   * changes a folder from another tab or device. */
  const [folders, setFolders] = React.useState<Folder[]>(
    () => initialData.folders ?? [],
  );
  // Follow the server list, without a frame showing the previous one.
  if (useChanged(initialData.folders)) setFolders(initialData.folders ?? []);

  /** Per-story folder_ids overrides. Mirrors watch-main's pattern: when
   *  the user toggles a folder via the dialog we update this map
   *  optimistically and fall back to it when rendering folder badges
   *  or filtering by folder. */
  const [folderOverrides, setFolderOverrides] = React.useState<
    Map<number, string[]>
  >(() => new Map());

  /* ── Action state ──
   * `locallyUnsaved` is the source of truth for "is this story still in
   * my library this session?" — once unsaved, the row disappears even
   * before the next refetch. Re-saving a story (clicking save again)
   * brings it back. Library RowActions only exposes Save/Unsave, so
   * that's the only optimistic state we need to track here. */
  const [locallyUnsaved, setLocallyUnsaved] = React.useState<Set<number>>(
    () => new Set(),
  );
  const [activeStoryId, setActiveStoryId] = React.useState<number | null>(null);
  const [activeArticleId, setActiveArticleId] = React.useState<number | null>(
    null,
  );

  /* ── Filter / view state ──
   * Library has 3 axes:
   *   - granularity : Apple-Photos-style zoom tab (Day/Week/Month/Year/All)
   *                   that GROUPS the list visually (not a filter)
   *   - saved view  : saved-view criteria (loads into `advanced`)
   *   - advanced    : ad-hoc dialog state (mutex with saved view)
   *   - search      : lives in `advanced.query` (composes freely)
   *
   * Saved view ⊕ ad-hoc-advanced is the only mutex (both write the same slot).
   * Granularity composes with everything — it only changes the rendering.
   *
   * There is no folder filter here: /library/{id} owns folder-scoped
   * browsing, so layering a folder filter on top of the saved corpus
   * would be redundant. The Folder button
   * on each row (Save · Folder action set) still files stories into
   * folders — that's a curation action, not a filter. */
  const [granularity, setGranularity] = React.useState<Granularity>("month");
  const [currentViewId, setCurrentViewIdRaw] =
    React.useState<string | null>(null);
  const [advanced, setAdvanced] = React.useState<Advanced>(emptyAdvanced);
  const [filtersOpen, setFiltersOpen] = React.useState(false);

  const setCurrentView = React.useCallback(
    (viewId: string | null) => {
      setCurrentViewIdRaw(viewId);
      if (viewId !== null) {
        const v = views.find((x) => x.id === viewId);
        // normalizeAdvanced — older saved views may lack newer Advanced
        // fields (e.g. articleTypes); merge with defaults to avoid
        // `Cannot read properties of undefined` in FilterPicker.
        setAdvanced(normalizeAdvanced(v?.criteria));
      } else {
        setAdvanced(emptyAdvanced);
      }
    },
    [views],
  );

  /** When the user applies ad-hoc filters via the dialog, detach from any
   *  active saved view — manual edit is ambiguous, prefer to surface
   *  "you've moved beyond the saved selection". Same convention as Watch. */
  const applyAdvanced = React.useCallback((next: Advanced) => {
    setAdvanced(next);
    setCurrentViewIdRaw(null);
  }, []);

  /** Search bar — wraps the query field inside `advanced`. Mutating the
   *  query alone DOES NOT detach from a saved view (search composes freely). */
  const setQuery = React.useCallback((q: string) => {
    setAdvanced((a) => ({ ...a, query: q }));
  }, []);
  const query = advanced.query;

  const visibleStories = React.useMemo(
    () =>
      allStories
        .filter(
          (s) => s.story_id !== undefined && !locallyUnsaved.has(s.story_id),
        )
        .map((s) => {
          const sid = s.story_id;
          if (sid === undefined) return s;
          const ov = folderOverrides.get(sid);
          if (ov === undefined || !s.user_state) return s;
          return { ...s, user_state: { ...s.user_state, folder_ids: ov } };
        }),
    [allStories, locallyUnsaved, folderOverrides],
  );

  const advancedCount = countAdvanced(advanced);

  /** Aggregations are computed on the saved corpus — drives the filter
   *  dialog's per-value pills (when in ad-hoc mode). The same shape as
   *  Watch's aggs, just over a different stories set. */
  const aggs = React.useMemo(
    () => aggregate(visibleStories, [], locale),
    [visibleStories, locale],
  );

  /** Filtered + sorted stories — granularity grouping happens at render
   *  time (it's just visual chunking, not a filter). */
  const displayed = React.useMemo(() => {
    const f = applyFilters(visibleStories, [], emptyScope, advanced);
    return [...f.stories].sort((a, b) => {
      // Sort by save time DESC — when grouping by granularity (Day/Week/…)
      // the section headers track saved_at, so sorting by saved_at
      // produces clean chronological sections. Fallback to article
      // recency for stories missing saved_at (shouldn't happen, defensive).
      const sa = a.saved_at ?? latestPublished(a.articles) ?? "";
      const sb = b.saved_at ?? latestPublished(b.articles) ?? "";
      return sb.localeCompare(sa);
    });
  }, [visibleStories, advanced]);

  /** Group displayed stories by the current granularity for section
   *  rendering. With granularity="all", returns a single section. */
  const sections = React.useMemo(() => {
    if (granularity === "all") {
      return displayed.length > 0
        ? [{ key: "", label: "", stories: displayed }]
        : [];
    }
    const map = new Map<string, Story[]>();
    for (const s of displayed) {
      if (!s.saved_at) continue;
      const k = granularityKey(s.saved_at, granularity);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(s);
    }
    // Sort sections by key DESC (most recent first).
    const entries = [...map.entries()].sort((a, b) =>
      b[0].localeCompare(a[0]),
    );
    return entries.map(([key, stories]) => ({
      key,
      label: granularityLabel(key, granularity, locale),
      stories,
    }));
  }, [displayed, granularity, locale]);

  const isSearching = query.trim().length > 0;

  /** Share / export handler — same UX as in Watch (clipboard copy + toast).
   *  Lives only on the DetailPanel's bottom CTA; the library row cards
   *  don't carry a share button. */
  const handleShare = useStoryShare(displayed, []);

  /* ── Action handlers ── */
  // Closed stories that the user unsaves are gone for good (the cleanup
  // purges them once nothing protects them anymore). Gate that path behind
  // an explicit confirmation; active stories still unsave silently because
  // re-saving from Watch brings them back.
  const [confirmingStoryId, setConfirmingStoryId] = React.useState<number | null>(
    null,
  );

  const performUnsave = React.useCallback(async (sid: number) => {
    setLocallyUnsaved((prev) => {
      const n = new Set(prev);
      n.add(sid);
      return n;
    });
    try {
      await unsaveStory(sid);
    } catch (err) {
      console.error("unsave failed", err);
      setLocallyUnsaved((prev) => {
        const n = new Set(prev);
        n.delete(sid);
        return n;
      });
    }
  }, []);

  const handleUnsave = React.useCallback(
    (sid: number) => {
      const story = allStories.find((s) => s.story_id === sid);
      if (story?.status === "closed") {
        setConfirmingStoryId(sid);
        return;
      }
      void performUnsave(sid);
    },
    [allStories, performUnsave],
  );

  const confirmUnsave = React.useCallback(() => {
    if (confirmingStoryId !== null) {
      const sid = confirmingStoryId;
      setConfirmingStoryId(null);
      void performUnsave(sid);
    }
  }, [confirmingStoryId, performUnsave]);

  const handleSave = React.useCallback(async (sid: number) => {
    // Re-saving a story we just unsaved this session: bring it back.
    setLocallyUnsaved((prev) => {
      if (!prev.has(sid)) return prev;
      const n = new Set(prev);
      n.delete(sid);
      return n;
    });
    try {
      await saveStory(sid);
    } catch (err) {
      console.error("save failed", err);
      setLocallyUnsaved((prev) => {
        const n = new Set(prev);
        n.add(sid);
        return n;
      });
    }
  }, []);

  /* ── Folder picker (Add/remove story to/from a folder) ──
   *  Mirrors watch-main's flow: track the open story, look up effective
   *  folder_ids (override > base user_state), and run optimistic updates
   *  on both `folderOverrides` and the folder's `story_count`. */
  const [folderPickerStoryId, setFolderPickerStoryId] = React.useState<
    number | null
  >(null);

  const handleOpenFolders = React.useCallback((sid: number) => {
    setFolderPickerStoryId(sid);
  }, []);

  const currentFolderIdsFor = React.useCallback(
    (sid: number): string[] => {
      const ov = folderOverrides.get(sid);
      if (ov !== undefined) return ov;
      const story = allStories.find((s) => s.story_id === sid);
      return story?.user_state?.folder_ids ?? [];
    },
    [folderOverrides, allStories],
  );

  const setFolderIds = React.useCallback(
    (sid: number, next: string[]) => {
      setFolderOverrides((prev) => {
        const m = new Map(prev);
        m.set(sid, next);
        return m;
      });
    },
    [],
  );

  const handleAddToFolder = React.useCallback(
    async (targetFolderId: string) => {
      const sid = folderPickerStoryId;
      if (sid === null) return;
      const prev = currentFolderIdsFor(sid);
      if (prev.includes(targetFolderId)) return;
      setFolderIds(sid, [...prev, targetFolderId]);
      setFolders((fs) =>
        fs.map((f) =>
          f.id === targetFolderId
            ? { ...f, story_count: f.story_count + 1 }
            : f,
        ),
      );
      try {
        await addStoryToFolder(targetFolderId, sid);
      } catch (err) {
        console.error("add to folder failed", err);
        setFolderIds(sid, prev);
        setFolders((fs) =>
          fs.map((f) =>
            f.id === targetFolderId
              ? { ...f, story_count: Math.max(0, f.story_count - 1) }
              : f,
          ),
        );
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, setFolderIds],
  );

  const handleRemoveFromFolder = React.useCallback(
    async (targetFolderId: string) => {
      const sid = folderPickerStoryId;
      if (sid === null) return;
      const prev = currentFolderIdsFor(sid);
      if (!prev.includes(targetFolderId)) return;
      setFolderIds(sid, prev.filter((id) => id !== targetFolderId));
      setFolders((fs) =>
        fs.map((f) =>
          f.id === targetFolderId
            ? { ...f, story_count: Math.max(0, f.story_count - 1) }
            : f,
        ),
      );
      try {
        await removeStoryFromFolder(targetFolderId, sid);
      } catch (err) {
        console.error("remove from folder failed", err);
        setFolderIds(sid, prev);
        setFolders((fs) =>
          fs.map((f) =>
            f.id === targetFolderId
              ? { ...f, story_count: f.story_count + 1 }
              : f,
          ),
        );
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, setFolderIds],
  );

  /** Inline create from the picker — server-side create only. The
   *  picker stages the new folder.id into its draft; the membership
   *  change ships at Save commit via `handleAddToFolder`. */
  const handlePickerCreate = React.useCallback(
    async (name: string) => {
      const created = await createFolder(name);
      setFolders((fs) => [...fs, created]);
      return created;
    },
    [],
  );

  const toggleStory = React.useCallback((sid: number) => {
    setActiveStoryId((cur) => (cur === sid ? null : sid));
    setActiveArticleId(null);
    markStoryRead(sid).catch((err) => console.error("read failed", err));
  }, []);

  const closeStory = React.useCallback(() => {
    setActiveStoryId(null);
    setActiveArticleId(null);
  }, []);

  const handleArticleConsume = React.useCallback((articleId: number) => {
    markArticleRead(articleId).catch((err) =>
      console.error("article-read persist failed", err),
    );
  }, []);

  const handleArticlePreview = React.useCallback((articleId: number) => {
    setActiveArticleId(articleId);
  }, []);

  // Auto-close the detail panel when the active story leaves the
  // currently-displayed set (bucket switch, search query, unsave, …).
  //
  // This is an invariant, not a reaction: a panel open on a story that
  // is no longer in the list is never a valid state, so it is corrected
  // during render rather than one frame later. `closeStory` clears the
  // id, which makes the condition false on the retry — no loop.
  if (
    activeStoryId !== null &&
    !displayed.some((s) => s.story_id === activeStoryId)
  ) {
    closeStory();
  }

  /* ── Render ── */
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <LibraryNav
        folders={folders}
        current="bookmarks"
        bookmarkCount={visibleStories.length}
        onCreateFolder={() => setCreatingFolder(true)}
      />

      {/* Sub-header + filter bar */}
      <div className="border-b border-border bg-bg shrink-0">
        <div className="max-w-[880px] mx-auto px-3 pt-3 pb-2 flex items-center gap-2">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-text">
            {t("title")}
          </h1>
          <span className="text-text-4">·</span>
          <span className="text-[12px] tabular-nums text-text-3">
            {t("saves", { count: visibleStories.length })}
          </span>
          <div className="flex-1" />
        </div>

        <div className="max-w-[880px] mx-auto px-3 pb-3 flex items-center gap-2">
          <Tabs
            value={granularity}
            onValueChange={(v) => setGranularity(v as Granularity)}
          >
            <TabsList className="h-auto bg-bg-elev border border-border rounded-md p-0.5 gap-0.5">
              {GRANULARITY_ORDER.map((g) => (
                <TabsTrigger
                  key={g}
                  value={g}
                  className={cn(
                    "px-2.5 py-1 rounded-[5px]",
                    "text-[12px] font-medium text-text-3",
                    "transition-colors duration-100",
                    "hover:text-text",
                    "data-[state=active]:bg-bg data-[state=active]:text-text",
                    "data-[state=active]:shadow-sm data-[state=active]:font-semibold",
                  )}
                >
                  {tGran(g)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <ViewPicker
            views={views}
            currentViewId={currentViewId}
            onChange={setCurrentView}
            allLabel={t("viewAll")}
            emptyLabel={t("viewEmpty")}
          />

          <div className="flex-1" />

          <span className="text-[11.5px] tabular-nums text-text-4 shrink-0">
            {t("results", { count: displayed.length })}
          </span>

          <SearchInput size="sm" inputClassName="w-[160px]" value={query} onChange={setQuery} />

          {/* Advanced filters — hidden when a saved view is active (it
           *  locks advanced state, ad-hoc filtering would conflict). */}
          {currentViewId === null && (
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              title={tList("advancedFilters")}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
                "border text-[12px] font-medium cursor-pointer",
                "transition-colors duration-100",
                advancedCount > 0
                  ? "bg-text text-bg border-text shadow-sm hover:bg-text-2 hover:border-text-2"
                  : "bg-bg-elev text-text-2 border-border hover:bg-bg-hover hover:text-text",
              )}
            >
              <SlidersHorizontal size={11} strokeWidth={1.6} />
              <span>{tList("filters")}</span>
              {advancedCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-bg/20 text-bg text-[10px] font-semibold tabular-nums">
                  {advancedCount}
                </span>
              )}
            </button>
          )}
        </div>
      </div>

      {/* List + detail panel */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 overflow-y-auto min-h-0">
          {allStories.length === 0 ? (
            <EmptyLibrary />
          ) : displayed.length === 0 ? (
            <EmptyResults searching={isSearching} />
          ) : (
            <div className="max-w-[880px] mx-auto px-3 pt-3 pb-12 flex flex-col gap-5">
              {sections.map((section) => (
                <div key={section.key || "all"} className="flex flex-col gap-2">
                  {section.label && (
                    <div className="sticky top-0 z-10 -mx-3 px-3 py-1.5 bg-bg/95 backdrop-blur-sm">
                      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">
                        {section.label}
                        <span className="ml-2 text-text-4 font-medium normal-case tracking-normal">
                          ·  {section.stories.length}
                        </span>
                      </h3>
                    </div>
                  )}
                  {section.stories.map((story) => {
                    const sid = story.story_id;
                    return (
                      <ClusterCard
                        key={sid}
                        story={story}
                        active={activeStoryId === sid}
                        onToggle={() => sid !== undefined && toggleStory(sid)}
                        actionsVariant="library"
                        onSave={handleSave}
                        onUnsave={handleUnsave}
                        onOpenFolders={handleOpenFolders}
                        showFullDate
                        activeArticleId={activeArticleId}
                        onArticleConsume={handleArticleConsume}
                        onArticlePreview={handleArticlePreview}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <DetailPanel
          stories={displayed}
          singletons={[]}
          activeStoryId={activeStoryId}
          activeArticleId={activeArticleId}
          onClose={closeStory}
          onBackToCluster={() => setActiveArticleId(null)}
          onShare={handleShare}
        />
      </div>

      <Dialog
        open={confirmingStoryId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmingStoryId(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("confirmUnsaveTitle")}</DialogTitle>
            <DialogDescription>{t("confirmUnsaveDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmingStoryId(null)}
            >
              {t("confirmUnsaveCancel")}
            </Button>
            <Button variant="destructive" onClick={confirmUnsave}>
              {t("confirmUnsaveConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ad-hoc advanced filters dialog (reused from Watch). Library
       *  applies the same Advanced shape to the saved corpus. */}
      <FiltersDialog
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        advanced={advanced}
        aggs={aggs}
        onApply={applyAdvanced}
      />

      {/* Folder picker — opens from the Folder button on each library
       *  row. Mirrors the Watch picker; Save and Folder stay independent
       *  (toggling a folder doesn't touch the story's saved state). */}
      <FolderPickerDialog
        open={folderPickerStoryId !== null}
        onOpenChange={(o) => {
          if (!o) setFolderPickerStoryId(null);
        }}
        folders={folders}
        selectedFolderIds={
          folderPickerStoryId !== null
            ? currentFolderIdsFor(folderPickerStoryId)
            : []
        }
        onAdd={handleAddToFolder}
        onRemove={handleRemoveFromFolder}
        onCreate={handlePickerCreate}
      />

      <FolderEditDialog
        open={creatingFolder}
        onOpenChange={setCreatingFolder}
        mode="create"
        onSubmit={async (name) => {
          const created = await createFolder(name);
          router.push(`/library/${created.id}`);
          router.refresh();
        }}
      />
    </div>
  );
}

/* ─────────── Sub-components ─────────── */

function EmptyLibrary() {
  const t = useTranslations("library");
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-[420px] space-y-3">
        <p className="text-[14px] font-medium text-text">{t("emptyTitle")}</p>
        <p className="text-[12px] text-text-3 leading-relaxed">
          {t("emptyDescription")}
        </p>
        <p className="pt-2">
          <Link
            href="/watch"
            className="text-[12px] text-text-2 hover:text-text underline-offset-2 hover:underline"
          >
            {t("goToWatch")}
          </Link>
        </p>
      </div>
    </div>
  );
}

function EmptyResults({ searching }: { searching: boolean }) {
  const t = useTranslations("library");
  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-[380px] space-y-2">
        <p className="text-[13px] text-text-2">
          {searching ? t("noResultsSearching") : t("noResultsFiltered")}
        </p>
        <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-text-4">
          {searching ? t("refineSearch") : t("refineFilters")}
        </p>
      </div>
    </div>
  );
}
