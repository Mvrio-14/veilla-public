import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cva } from "class-variance-authority";
import { useLocale, useTranslations } from "next-intl";
import { TitleFlag } from "./_atoms";
import { ClusterArticleRow } from "./cluster-article-row";
import { RowActions } from "./row-actions";
import { cn } from "@/lib/utils";
import {
  dominantCategory,
  fmtAbsolute,
  fmtSmartClock,
  latestPublished,
} from "@/lib/format";
import {
  type Advanced,
  type Scope,
  advancedIsActive,
  articleMatchesAdvanced,
  articleMatchesScope,
  emptyAdvanced,
  emptyScope,
  scopeIsActive,
} from "@/lib/filter";
import type { Story } from "@/lib/types";
import { useCategoryLabel } from "@/lib/use-category-label";
import { useChanged } from "@/lib/use-changed";

const cardStyles = cva(
  cn(
    "relative bg-bg-elev border rounded-[10px] cursor-pointer",
    "transition-[border-color,box-shadow,background] duration-[120ms]",
  ),
  {
    variants: {
      active: {
        true: "border-text shadow-[0_0_0_1px_var(--text)]",
        false: "border-border hover:border-border-strong",
      },
    },
    defaultVariants: { active: false },
  },
);

/**
 * Multi-source cluster card.
 * Click on header → expands inline AND notifies parent (which opens detail panel).
 */
export function ClusterCard({
  story,
  active,
  onToggle,
  onSave,
  onUnsave,
  onFollow,
  onUnfollow,
  onIgnored,
  onUnignored,
  onOpenFolders,
  onRemoveFromFolder,
  viewIgnored = false,
  locallyRead = false,
  showFullDate = false,
  actionsVariant = "watch",
  consumedArticles,
  activeArticleId,
  onArticleConsume,
  onArticlePreview,
  scope = emptyScope,
  advanced = emptyAdvanced,
}: {
  story: Story;
  active: boolean;
  onToggle: () => void;
  onSave?: (storyId: number) => void;
  onUnsave?: (storyId: number) => void;
  onFollow?: (storyId: number) => void;
  onUnfollow?: (storyId: number) => void;
  onIgnored?: (storyId: number) => void;
  onUnignored?: (storyId: number) => void;
  /** Opens the FolderPickerDialog for this story (passed through to
   *  RowActions). Optional. */
  onOpenFolders?: (storyId: number) => void;
  /** Folder-context only: detach this story from the folder currently
   *  being viewed (passed through to RowActions). */
  onRemoveFromFolder?: (storyId: number) => void;
  /** Action set rendered in the meta row.
   *   - "watch"   : Save + Folder + Ignore
   *   - "library" : Save + Folder
   *   - "folder"  : Save + Folder + Remove-from-current-folder */
  actionsVariant?: "watch" | "library" | "folder";
  viewIgnored?: boolean;
  /** Has the user opened this story this session? Beats user_state.is_unread
   *  for an instant local update before the next /watch refetch. */
  locallyRead?: boolean;
  /** /library uses absolute date+time on the meta row — bucket headers
   *  give context but the card alone must still be self-orienting. */
  showFullDate?: boolean;
  /** Article IDs already consumed this session — those rows skip the dot. */
  consumedArticles?: Set<number>;
  /** Article currently previewed in the detail panel (highlighted row). */
  activeArticleId?: number | null;
  /** Fires on every article click. */
  onArticleConsume?: (articleId: number) => void;
  /** Fires on a plain click only (no modifier). */
  onArticlePreview?: (articleId: number) => void;
  /** Active sidebar scope. Drives intra-cluster article filtering — only
   *  matching articles render by default, with a "view all" toggle to
   *  reveal the rest dimmed. Defaults to `emptyScope` for callers (like
   *  /library) that don't expose scope state. */
  scope?: Scope;
  /** Active advanced filters from the dialog/search bar. Same role as
   *  `scope` for intra-cluster filtering. */
  advanced?: Advanced;
}) {
  const t = useTranslations("cluster");
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();
  // Cluster categories come pre-ranked (top 2 most frequent across the
  // cluster's articles) from the backend. Fall back to the dominant one
  // computed client-side if the backend list is empty. Capped at 3 to
  // keep the meta row compact even if the LLM gets chatty later.
  const categoriesFromStory = (story.categories ?? []).filter(
    (c) => c && c !== "Other",
  );
  const fallbackCategory = dominantCategory(story.articles);
  const categories = (
    categoriesFromStory.length > 0
      ? categoriesFromStory
      : fallbackCategory
        ? [fallbackCategory]
        : []
  )
    .slice(0, 3)
    .map(categoryLabel);
  const latest = latestPublished(story.articles);
  const time = showFullDate
    ? fmtAbsolute(latest, locale)
    : fmtSmartClock(latest, locale);
  const sourceCount = story.n_sources;
  const articleCount = story.articles.length;
  const storyId = story.articles[0]?.story_id;
  const hasUpdate = (story.user_state?.has_update ?? false) && !locallyRead;
  const isFresh =
    (story.user_state?.is_unread ?? false) && !hasUpdate && !locallyRead;
  // Count of articles arrived since the user last opened this story —
  // drives the "+N" badge next to the title (mirrors the handoff's
  // `story.updatedSince` count). Only meaningful when has_update is set.
  const readAt = story.user_state?.read_at ?? null;
  const newArticlesCount =
    hasUpdate && readAt
      ? story.articles.filter(
          (a) => (a.published_at || "") > readAt,
        ).length
      : 0;
  // Tighter signal than has_update: fires only when the timeline got an
  // actual new entry since the last visit (story_updates rows, not just
  // an article attached without producing a delta). Only shown when the
  // user has read this story before — for never-opened stories the blue
  // "new" dot already conveys novelty.
  const latestUpdateAt = story.updates?.[0]?.added_at ?? null;
  const hasNewUpdate =
    !locallyRead &&
    !!readAt &&
    !!latestUpdateAt &&
    latestUpdateAt > readAt;

  // ─── Intra-cluster filtering ───
  // With a sidebar scope or advanced filter active, the articles that
  // don't match are hidden by default and shown dimmed under a "view
  // all" toggle. We reuse the same matchers that `applyFilters` uses
  // for the story list, so card-level matching stays in sync with the
  // story-level decision to include the cluster in the list at all.
  const cardHasFilter = scopeIsActive(scope) || advancedIsActive(advanced);

  const matchingIds = React.useMemo(() => {
    if (!cardHasFilter) return null;
    const ids = new Set<number>();
    for (const a of story.articles) {
      if (
        articleMatchesScope(a, scope) &&
        articleMatchesAdvanced(a, advanced, story.title)
      ) {
        ids.add(a.id);
      }
    }
    return ids;
  }, [cardHasFilter, scope, advanced, story.articles, story.title]);

  const nonMatchingCount =
    cardHasFilter && matchingIds
      ? story.articles.length - matchingIds.size
      : 0;

  const [showAll, setShowAll] = React.useState(false);

  // Reset to filtered-only whenever the filter criteria change. Without
  // this, switching scopes while a card was expanded with "show all" on
  // would keep the dimmed rows visible under the new filter, which is
  // never what the user wants.
  const scopeChanged = useChanged(scope);
  const advancedChanged = useChanged(advanced);
  if (scopeChanged || advancedChanged) setShowAll(false);

  // Newest-first.
  const sorted = [...story.articles].sort((a, b) =>
    (b.published_at || "").localeCompare(a.published_at || ""),
  );

  return (
    <article className={cardStyles({ active })}>
      <header
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex flex-col gap-[5px] px-3 py-2.5"
      >
        {/* Meta row */}
        <div className="flex items-center gap-[5px] min-h-5 leading-none text-[11px] text-text-3">
          <ChevronRight
            size={11}
            strokeWidth={1.6}
            className={cn(
              "shrink-0 text-text-4 transition-transform duration-200",
              active && "rotate-90 text-text-2",
            )}
          />

          <span className="inline-flex items-baseline gap-[3px] tabular-nums text-[11.5px] font-medium text-text-3 shrink-0 whitespace-nowrap">
            <strong className="font-semibold text-text">{sourceCount}</strong>
            <span>&nbsp;{t("sourceLabel", { count: sourceCount })}</span>
            <span className="mx-0.5 text-text-4">·</span>
            <strong className="font-semibold text-text">{articleCount}</strong>
            <span>&nbsp;{t("articleLabel", { count: articleCount })}</span>
          </span>

          {categories.length > 0 && (
            <span className="font-medium text-text-3 truncate">
              {categories.join(" · ")}
            </span>
          )}

          <div className="flex-1" />

          {time && (
            <span className="font-mono tabular-nums text-[10.5px] text-text-3 shrink-0">
              {time}
            </span>
          )}

          {storyId !== undefined && (
            <RowActions
              storyId={storyId}
              state={story.user_state}
              variant={actionsVariant}
              onSave={onSave}
              onUnsave={onUnsave}
              onFollow={onFollow}
              onUnfollow={onUnfollow}
              onIgnored={onIgnored}
              onUnignored={onUnignored}
              onOpenFolders={onOpenFolders}
              onRemoveFromFolder={onRemoveFromFolder}
              viewIgnored={viewIgnored}
            />
          )}
        </div>

        {/* Title */}
        <h3 className="m-0 text-[14.5px] font-semibold tracking-[-0.012em] leading-[1.35] text-text [text-wrap:pretty] line-clamp-2">
          {isFresh && <TitleFlag kind="new" />}
          {hasUpdate && (
            <TitleFlag kind="updated">
              {newArticlesCount > 0 ? `+${newArticlesCount}` : "↗"}
            </TitleFlag>
          )}
          {story.title}
        </h3>

        {hasNewUpdate && (
          <div className="flex items-center gap-1 text-[11.5px] font-medium text-new-text">
            <span aria-hidden>↗</span>
            <span>{t("newUpdate")}</span>
          </div>
        )}
      </header>

      {/* Expanded accordion */}
      {active && sorted.length > 0 && (
        <div
          className="border-t border-border bg-[color-mix(in_oklab,var(--bg)_50%,var(--bg-elev))] py-1 rounded-b-[9px]"
          onClick={(e) => e.stopPropagation()}
        >
          {sorted
            .filter(
              (a) =>
                !cardHasFilter ||
                showAll ||
                (matchingIds?.has(a.id) ?? true),
            )
            .map((article) => {
              // Only flag "new" when the parent opted in by passing a Set —
              // /library doesn't track consumption and shouldn't show dots.
              const isNew =
                consumedArticles !== undefined &&
                !consumedArticles.has(article.id);
              // In "show all" mode, bold the rows that actually match the
              // active filter so the user can pick them out among the rest.
              // Off when no filter is active or when only matches are shown.
              const isHighlighted =
                cardHasFilter &&
                showAll &&
                matchingIds !== null &&
                matchingIds.has(article.id);
              return (
                <ClusterArticleRow
                  key={article.id}
                  article={article}
                  isNew={isNew}
                  isActive={activeArticleId === article.id}
                  isHighlighted={isHighlighted}
                  onConsume={onArticleConsume}
                  onPreview={onArticlePreview}
                />
              );
            })}

          {cardHasFilter && nonMatchingCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowAll((v) => !v);
              }}
              className={cn(
                "w-full text-left px-3 py-1.5 mt-0.5",
                "text-[11.5px] text-text-3 hover:text-text-2",
                "transition-colors",
              )}
            >
              {showAll
                ? t("hideExtra")
                : t("viewMore", { count: nonMatchingCount })}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
