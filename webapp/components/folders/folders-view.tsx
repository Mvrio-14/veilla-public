"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClusterCard } from "@/components/watch/cluster-card";
import { DetailPanel } from "@/components/watch/detail-panel";
import { FolderEditDialog } from "@/components/watch/folder-edit-dialog";
import { FolderPickerDialog } from "@/components/watch/folder-picker-dialog";
import { LibraryNav } from "@/components/library/library-nav";
import {
  addStoryToFolder,
  createFolder,
  deleteFolder,
  markArticleRead,
  markStoryRead,
  removeStoryFromFolder,
  renameFolder,
  saveStory,
  unsaveStory,
} from "@/lib/actions";
import { emptyAdvanced, emptyScope } from "@/lib/filter";
import {
  granularityKey,
  granularityLabel,
  GRANULARITY_ORDER,
  type Granularity,
} from "@/lib/library-granularity";
import { cn } from "@/lib/utils";
import { useStoryShare } from "@/lib/use-story-share";
import type { Folder, FolderData, Story, UserState } from "@/lib/types";
import { useChanged } from "@/lib/use-changed";

/**
 * Client wrapper for the standalone Dossiers mode. Layout mirrors the
 * Watch (sidebar | list | detail panel) but the surface is permanent —
 * no temporal window, no scope/advanced filters. The folder is
 * just a curated list to read through.
 *
 * Story actions reuse the same backend endpoints as Watch (save /
 * ignore / mark-read / move folders), with light optimistic overrides
 * stored locally. No advanced editorial state to track.
 */
export function FoldersView({
  data,
  folderId,
  storyIdFromUrl,
}: {
  data: FolderData;
  folderId: string;
  /** Seed `activeStoryId` on mount from the URL's `?story=X` param, so
   *  a link can open one story of the folder directly. Null when no
   *  `?story=` is present (= the user navigated to the folder
   *  manually). */
  storyIdFromUrl?: number | null;
}) {
  const router = useRouter();
  const t = useTranslations("foldersView");
  const tGran = useTranslations("granularity");
  const locale = useLocale();

  /* ── Granularity (Day / Week / Month / Year / All) ──
   * Mirrors Library's Apple-Photos-style zoom tab. Drives only the
   * visual chunking — not a filter. The section keys come from each
   * story's `added_at` (filed-to-folder time), same role `saved_at`
   * plays in the Library. */
  const [granularity, setGranularity] = React.useState<Granularity>("month");

  /* ── Folders state (live, optimistic) ──
   * Kept locally so inline-create from the picker can update the list
   * without waiting on a router.refresh() round-trip. Re-seeded when
   * the server feeds fresh data via `data.folders`. */
  const [foldersList, setFoldersList] = React.useState<Folder[]>(
    () => data.folders,
  );
  // Follow the server list, without a frame showing the previous one.
  if (useChanged(data.folders)) setFoldersList(data.folders);

  /* ── Active story / article (client state) ──
   * Seeded from `storyIdFromUrl` on mount so a deep link lands with the
   * right story already open. */
  const [activeStoryId, setActiveStoryId] = React.useState<number | null>(
    storyIdFromUrl ?? null,
  );
  const [activeArticleId, setActiveArticleId] = React.useState<number | null>(
    null,
  );

  /* ── URL sync ──
   * Mirror of /watch's `activeStoryId ↔ ?story=X` sync. Lets the user
   * copy-paste the address bar to share their current view + open
   * story, and keeps deep-links (notifications, emails) round-tripping
   * cleanly. `replaceState` (not push) so each click doesn't pollute
   * browser history. */
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("story");
    const target = activeStoryId !== null ? String(activeStoryId) : null;
    if (current === target) return;
    if (target !== null) {
      url.searchParams.set("story", target);
    } else {
      url.searchParams.delete("story");
    }
    window.history.replaceState(null, "", url.toString());
  }, [activeStoryId]);

  /* ── Read state (optimistic) ── */
  const [locallyRead, setLocallyRead] = React.useState<Set<number>>(
    () => new Set(),
  );

  /* ── Consumed articles (per-row blue dot) ── */
  const [consumedArticles, setConsumedArticles] = React.useState<Set<number>>(
    () => new Set(),
  );

  /* ── Optimistic per-story overrides (saved / ignored / folder_ids) ── */
  const [overrides, setOverrides] = React.useState<
    Map<number, Partial<UserState>>
  >(() => new Map());

  const applyOverride = React.useCallback(
    (storyId: number, patch: Partial<UserState>) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(storyId, { ...next.get(storyId), ...patch });
        return next;
      });
    },
    [],
  );

  const consumeArticles = React.useCallback((ids: Iterable<number>) => {
    const arr = Array.from(ids);
    if (arr.length === 0) return;
    const fresh: number[] = [];
    setConsumedArticles((prev) => {
      const next = new Set(prev);
      for (const id of arr) {
        if (!next.has(id)) {
          next.add(id);
          fresh.push(id);
        }
      }
      return fresh.length > 0 ? next : prev;
    });
    Promise.all(fresh.map((id) => markArticleRead(id))).catch((err) => {
      console.error("article-read persist failed", err);
    });
  }, []);

  const consumeStoryArticles = React.useCallback(
    (storyId: number) => {
      const story = data.stories.find(
        (s) => s.articles[0]?.story_id === storyId,
      );
      if (!story) return;
      // Opening the card shows every article, so all of them are seen.
      consumeArticles(story.articles.map((a) => a.id));
    },
    [data.stories, consumeArticles],
  );

  const toggleStory = React.useCallback(
    (storyId: number) => {
      setActiveStoryId((current) => {
        const wasOpen = current === storyId;
        if (wasOpen) {
          consumeStoryArticles(storyId);
        } else if (current !== null) {
          consumeStoryArticles(current);
        }
        return wasOpen ? null : storyId;
      });
      setActiveArticleId(null);
      setLocallyRead((prev) => {
        if (prev.has(storyId)) return prev;
        const next = new Set(prev);
        next.add(storyId);
        return next;
      });
      markStoryRead(storyId).catch((err) => {
        console.error("mark-as-read failed", err);
      });
    },
    [consumeStoryArticles],
  );

  const closeStory = React.useCallback(() => {
    setActiveStoryId((current) => {
      if (current !== null) consumeStoryArticles(current);
      return null;
    });
    setActiveArticleId(null);
  }, [consumeStoryArticles]);

  /* ── Save / Ignore handlers (optimistic) ── */
  const handleSave = React.useCallback(
    (storyId: number) => {
      applyOverride(storyId, { saved: true });
      saveStory(storyId).catch((err) => {
        console.error("save failed", err);
        applyOverride(storyId, { saved: false });
      });
    },
    [applyOverride],
  );

  const handleUnsave = React.useCallback(
    (storyId: number) => {
      applyOverride(storyId, { saved: false });
      unsaveStory(storyId).catch((err) => {
        console.error("unsave failed", err);
        applyOverride(storyId, { saved: true });
      });
    },
    [applyOverride],
  );

  /* ── Remove a story from the current folder (folder-context only) ──
   * Pulls the story out of the local list optimistically, then fires
   * the DELETE. The other detail-panel state on the same row stays
   * intact in case the user navigates back. */
  const [removedStoryIds, setRemovedStoryIds] = React.useState<Set<number>>(
    () => new Set(),
  );

  const handleRemoveFromCurrentFolder = React.useCallback(
    (storyId: number) => {
      setRemovedStoryIds((prev) => {
        if (prev.has(storyId)) return prev;
        const next = new Set(prev);
        next.add(storyId);
        return next;
      });
      // If this story was the one open in the detail panel, close it —
      // it's about to disappear from the list.
      if (activeStoryId === storyId) {
        setActiveStoryId(null);
        setActiveArticleId(null);
      }
      removeStoryFromFolder(folderId, storyId).catch((err) => {
        console.error("remove from folder failed", err);
        setRemovedStoryIds((prev) => {
          if (!prev.has(storyId)) return prev;
          const next = new Set(prev);
          next.delete(storyId);
          return next;
        });
      });
    },
    [folderId, activeStoryId],
  );

  /* ── Folder CRUD dialog ── */
  const [folderDialog, setFolderDialog] = React.useState<
    | { mode: "create" }
    | { mode: "edit"; folder: Folder }
    | null
  >(null);

  const handleCreateFolder = React.useCallback(() => {
    setFolderDialog({ mode: "create" });
  }, []);

  const handleEditCurrentFolder = React.useCallback(() => {
    const current = data.folders.find((f) => f.id === folderId);
    if (current) setFolderDialog({ mode: "edit", folder: current });
  }, [data.folders, folderId]);

  const handleFolderDialogSubmit = React.useCallback(
    async (name: string) => {
      if (folderDialog?.mode === "create") {
        const created = await createFolder(name);
        // Navigate to the freshly created folder so the user sees the
        // result of their action immediately.
        router.push(`/library/${created.id}`);
        router.refresh();
      } else if (folderDialog?.mode === "edit") {
        await renameFolder(folderDialog.folder.id, name);
        router.refresh();
      }
    },
    [folderDialog, router],
  );

  const handleFolderDialogDelete = React.useCallback(
    async (id: string) => {
      await deleteFolder(id);
      // Back to the library's first list, which always exists.
      router.push("/library");
      router.refresh();
    },
    [router],
  );

  /* ── Folder picker (move-to-another-folder action on a story) ── */
  const [folderPickerStoryId, setFolderPickerStoryId] = React.useState<
    number | null
  >(null);

  const handleOpenFolders = React.useCallback((storyId: number) => {
    setFolderPickerStoryId(storyId);
  }, []);

  const currentFolderIdsFor = React.useCallback(
    (storyId: number): string[] => {
      const override = overrides.get(storyId);
      if (override?.folder_ids !== undefined) return override.folder_ids;
      const story = data.stories.find(
        (s) => s.articles[0]?.story_id === storyId,
      );
      return story?.user_state?.folder_ids ?? [];
    },
    [overrides, data.stories],
  );

  const handleAddToFolder = React.useCallback(
    async (targetFolderId: string) => {
      const storyId = folderPickerStoryId;
      if (storyId === null) return;
      const prev = currentFolderIdsFor(storyId);
      if (prev.includes(targetFolderId)) return;
      // Save and Folder are independent. Adding to a folder
      // updates folder_ids only; saved state stays whatever it was.
      applyOverride(storyId, {
        folder_ids: [...prev, targetFolderId],
      });
      try {
        await addStoryToFolder(targetFolderId, storyId);
      } catch (err) {
        console.error("add to folder failed", err);
        applyOverride(storyId, { folder_ids: prev });
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, applyOverride],
  );

  const handleRemoveFromFolder = React.useCallback(
    async (targetFolderId: string) => {
      const storyId = folderPickerStoryId;
      if (storyId === null) return;
      const prev = currentFolderIdsFor(storyId);
      if (!prev.includes(targetFolderId)) return;
      applyOverride(storyId, {
        folder_ids: prev.filter((id) => id !== targetFolderId),
      });
      try {
        await removeStoryFromFolder(targetFolderId, storyId);
      } catch (err) {
        console.error("remove from folder failed", err);
        applyOverride(storyId, { folder_ids: prev });
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, applyOverride],
  );

  /** Inline create from the picker — server-side create only. The
   *  picker stages the new folder.id into its draft; the membership
   *  change ships at Save commit via `handleAddToFolder`. We merge
   *  the new folder into the local list so the picker can render it
   *  immediately, without waiting on a router.refresh() round-trip. */
  const handlePickerCreate = React.useCallback(
    async (name: string) => {
      const created = await createFolder(name);
      setFoldersList((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  /* ── Merge user_state with optimistic overrides for rendering, and
   *    hide stories the user just removed from this folder. Sort by
   *    `added_at` DESC so the most recently filed story sits at the
   *    top of its section. */
  const mergedStories = React.useMemo(() => {
    const merged = data.stories
      .filter((s) => {
        const sid = s.articles[0]?.story_id;
        return sid === undefined || !removedStoryIds.has(sid);
      })
      .map((s) => {
        const sid = s.articles[0]?.story_id;
        const override = sid !== undefined ? overrides.get(sid) : undefined;
        if (!override || !s.user_state) return s;
        return { ...s, user_state: { ...s.user_state, ...override } };
      });
    return [...merged].sort((a, b) => {
      const aa = a.added_at ?? "";
      const bb = b.added_at ?? "";
      return bb.localeCompare(aa);
    });
  }, [data.stories, overrides, removedStoryIds]);

  /** Share / export handler — same UX as Watch and Library (clipboard
   *  copy + toast). Lives only on the DetailPanel's bottom CTA. */
  const handleShare = useStoryShare(mergedStories, data.singletons);

  /* ── Group merged stories by granularity for section rendering.
   *    With granularity="all", returns a single section. Mirrors
   *    saved-view's grouping logic — same shape, different time key
   *    (added_at vs saved_at). */
  const sections = React.useMemo(() => {
    if (granularity === "all") {
      return mergedStories.length > 0
        ? [{ key: "", label: "", stories: mergedStories }]
        : [];
    }
    const map = new Map<string, Story[]>();
    for (const s of mergedStories) {
      if (!s.added_at) continue;
      const k = granularityKey(s.added_at, granularity);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(s);
    }
    const entries = [...map.entries()].sort((a, b) =>
      b[0].localeCompare(a[0]),
    );
    return entries.map(([key, stories]) => ({
      key,
      label: granularityLabel(key, granularity, locale),
      stories,
    }));
  }, [mergedStories, granularity, locale]);

  return (
    <>
      <LibraryNav
        folders={foldersList}
        current={folderId}
        onCreateFolder={handleCreateFolder}
      />

      {/* Center column — folder header + sectioned story list */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        <FolderHeader
          folder={data.folder}
          storyCount={data.stories.length}
          onEdit={handleEditCurrentFolder}
        />

        {/* Granularity selector — same shape as Library's, drives only
            the section grouping below. */}
        <div className="border-b border-border bg-bg shrink-0">
          <div className="max-w-[880px] mx-auto px-3 py-2">
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
          </div>
        </div>

        {mergedStories.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-[13px] text-text-3 text-center max-w-[420px]">
              {t("emptyFolder")}
            </p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
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
                    const sid = story.articles[0]?.story_id;
                    if (sid === undefined) return null;
                    return (
                      <ClusterCard
                        key={sid}
                        story={story}
                        active={activeStoryId === sid}
                        onToggle={() => toggleStory(sid)}
                        onSave={handleSave}
                        onUnsave={handleUnsave}
                        onOpenFolders={handleOpenFolders}
                        onRemoveFromFolder={handleRemoveFromCurrentFolder}
                        actionsVariant="folder"
                        locallyRead={locallyRead.has(sid)}
                        consumedArticles={consumedArticles}
                        activeArticleId={activeArticleId}
                        onArticleConsume={(id) => consumeArticles([id])}
                        onArticlePreview={(id) => setActiveArticleId(id)}
                        scope={emptyScope}
                        advanced={emptyAdvanced}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <DetailPanel
        stories={mergedStories}
        singletons={data.singletons}
        activeStoryId={activeStoryId}
        activeArticleId={activeArticleId}
        onClose={closeStory}
        onBackToCluster={() => setActiveArticleId(null)}
        onShare={handleShare}
      />

      <FolderEditDialog
        open={folderDialog !== null}
        onOpenChange={(o) => {
          if (!o) setFolderDialog(null);
        }}
        mode={folderDialog?.mode ?? "create"}
        initialFolder={
          folderDialog?.mode === "edit" ? folderDialog.folder : undefined
        }
        onSubmit={handleFolderDialogSubmit}
        onDelete={handleFolderDialogDelete}
      />

      <FolderPickerDialog
        open={folderPickerStoryId !== null}
        onOpenChange={(o) => {
          if (!o) setFolderPickerStoryId(null);
        }}
        folders={foldersList}
        selectedFolderIds={
          folderPickerStoryId !== null
            ? currentFolderIdsFor(folderPickerStoryId)
            : []
        }
        onAdd={handleAddToFolder}
        onRemove={handleRemoveFromFolder}
        onCreate={handlePickerCreate}
      />
    </>
  );
}

/* ─────────── Folder header ─────────── */

function FolderHeader({
  folder,
  storyCount,
  onEdit,
}: {
  folder: FolderData["folder"];
  storyCount: number;
  onEdit: () => void;
}) {
  return (
    <header className="px-6 pt-6 pb-3 border-b border-border bg-bg-elev">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[18px] font-semibold tracking-[-0.012em] text-text truncate">
          {folder.name}
        </h1>
        <button
          type="button"
          onClick={onEdit}
          className="text-[11.5px] text-text-3 hover:text-text underline-offset-2 hover:underline cursor-pointer"
        >
          Renommer / supprimer
        </button>
      </div>
      <p className="mt-1 text-[12px] text-text-3">
        {storyCount} {storyCount === 1 ? "story" : "stories"}
      </p>
    </header>
  );
}

