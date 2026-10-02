"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useToast } from "@/components/ui/toast";
import { copyStoryToClipboard, type StoryExportLabels } from "./export-story";
import type { Singleton, Story } from "./types";

/**
 * Shared "share / export this story" handler used by every view that
 * renders a `<DetailPanel>` (Watch, Library, Folders). Encapsulates the
 * id → object lookup, the clipboard write, and the toast feedback so
 * each view stays a one-liner:
 *
 *   const handleShare = useStoryShare(stories, singletons);
 *   <DetailPanel ... onShare={handleShare} />
 *
 * The button itself lives in the panel (bottom of the cluster view) —
 * the cluster card RowActions don't carry it (cleaner toolbar, single
 * point of action).
 *
 * `singletons` defaults to `[]` because some views (Library, Folders)
 * don't render singletons. The hook handles both kinds via a union.
 */
export function useStoryShare(
  stories: Story[],
  singletons: Singleton[] = [],
): (storyId: number) => Promise<void> {
  const tActions = useTranslations("actions");
  const tExport = useTranslations("storyExport");
  const toast = useToast();

  const labels = React.useMemo<StoryExportLabels>(
    () => ({
      article:       (time) => tExport("article", { time }),
      firstArticle:  (time) => tExport("firstArticle", { time }),
      lastArticle:   (time) => tExport("lastArticle", { time }),
      sources:       (count) => tExport("sources", { count }),
      recentUpdates: tExport("recentUpdates"),
      sharedFrom:    tExport("sharedFrom"),
    }),
    [tExport],
  );

  return React.useCallback(
    async (storyId: number) => {
      const target =
        stories.find((s) => s.articles[0]?.story_id === storyId) ??
        singletons.find((a) => a.story_id === storyId);
      if (!target) return;
      try {
        await copyStoryToClipboard(target, labels);
        toast.show(tActions("copied"));
      } catch (err) {
        console.error("clipboard copy failed", err);
        toast.show(tActions("copyFailed"), "error");
      }
    },
    [stories, singletons, toast, tActions, labels],
  );
}
