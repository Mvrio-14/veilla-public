import { cva } from "class-variance-authority";
import { useLocale } from "next-intl";
import { Lang, TitleFlag, TreatmentChip } from "./_atoms";
import { RowActions } from "./row-actions";
import { cn } from "@/lib/utils";
import {
  decodeHtmlEntities,
  fmtAbsolute,
  fmtSmartClock,
} from "@/lib/format";
import type { Singleton } from "@/lib/types";
import { useCategoryLabel } from "@/lib/use-category-label";

const rowStyles = cva(
  cn(
    "relative flex flex-col gap-1 cursor-pointer",
    "px-3.5 py-2.5 rounded-md",
    "bg-bg-elev",
    "transition-colors duration-100",
  ),
  {
    variants: {
      active: {
        true: "bg-bg-sub",
        false: "hover:bg-bg-hover",
      },
    },
    defaultVariants: { active: false },
  },
);

/**
 * Single-article row. Two stacked lines: meta + title.
 * Click → opens detail panel for this article.
 */
export function SingletonRow({
  article,
  active,
  onToggle,
  onSave,
  onUnsave,
  onFollow,
  onUnfollow,
  onIgnored,
  onUnignored,
  onOpenFolders,
  viewIgnored = false,
  locallyRead = false,
  showFullDate = false,
}: {
  article: Singleton;
  active: boolean;
  onToggle: () => void;
  onSave?: (storyId: number) => void;
  onUnsave?: (storyId: number) => void;
  onFollow?: (storyId: number) => void;
  onUnfollow?: (storyId: number) => void;
  onIgnored?: (storyId: number) => void;
  onUnignored?: (storyId: number) => void;
  onOpenFolders?: (storyId: number) => void;
  viewIgnored?: boolean;
  locallyRead?: boolean;
  showFullDate?: boolean;
}) {
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();
  const hasUpdate = (article.user_state?.has_update ?? false) && !locallyRead;
  const isFresh =
    (article.user_state?.is_unread ?? false) && !hasUpdate && !locallyRead;
  // Show every LLM-tagged category (filter the "Other" placeholder),
  // capped at 3 so a chatty normalizer can't blow out the meta row.
  const categories = (article.category ?? [])
    .filter((c) => c && c !== "Other")
    .slice(0, 3)
    .map(categoryLabel);
  const time = showFullDate
    ? fmtAbsolute(article.published_at, locale)
    : fmtSmartClock(article.published_at, locale);
  const display = decodeHtmlEntities(
    article.title_normalized || article.title,
  );

  const metaSubText = categories.join(" · ");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={rowStyles({ active })}
    >
      {/* Right-edge active marker */}
      {active && (
        <span className="absolute right-0 top-0 bottom-0 w-0.5 bg-text rounded-l-sm" />
      )}

      {/* Meta */}
      <div className="flex items-center gap-1.5 min-h-5 text-[11.5px] text-text-3">
        <span className="font-semibold text-text tracking-[-0.005em] whitespace-nowrap">
          {article.source}
        </span>
        {/* Source-language chip — visible whenever the article's source
            language differs from the UI locale. See cluster-article-row
            for the rationale. */}
        {article.lang && article.lang !== locale && <Lang code={article.lang} />}
        {metaSubText && (
          <span className="text-text-3 font-medium truncate min-w-0">
            {metaSubText}
          </span>
        )}
        <TreatmentChip kind={article.article_type} />
        <div className="flex-1" />
        {time && (
          <span className="font-mono tabular-nums text-[11px] text-text-3 shrink-0">
            {time}
          </span>
        )}
        {article.story_id !== undefined && article.story_id !== null && (
          <RowActions
            storyId={article.story_id}
            state={article.user_state}
            onSave={onSave}
            onUnsave={onUnsave}
            onFollow={onFollow}
            onUnfollow={onUnfollow}
            onIgnored={onIgnored}
            onUnignored={onUnignored}
            onOpenFolders={onOpenFolders}
            viewIgnored={viewIgnored}
          />
        )}
      </div>

      {/* Title */}
      <div className="text-[13.5px] font-medium tracking-[-0.008em] leading-[1.4] text-text [text-wrap:pretty] line-clamp-2">
        {isFresh && <TitleFlag kind="new" />}
        {hasUpdate && <TitleFlag kind="updated">↗</TitleFlag>}
        {display}
      </div>
    </div>
  );
}
