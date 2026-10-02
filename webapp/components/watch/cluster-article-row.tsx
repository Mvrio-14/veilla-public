import { useLocale, useTranslations } from "next-intl";
import { Lang, TreatmentChip } from "./_atoms";
import { decodeHtmlEntities, fmtSmartClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Article } from "@/lib/types";

/**
 * Article row inside an expanded ClusterCard accordion.
 *
 * Plain click → preview in the detail panel (parent intercepts the
 *   navigation via `e.preventDefault`).
 * Cmd/Ctrl/Shift click → browser default (open in new tab) — gives power
 *   users their muscle-memory escape hatch back. Middle click already
 *   bypasses onClick in modern browsers.
 *
 * Consumption (blue-dot removal) fires on every click regardless of
 * modifier — once you decided to open the link, the row should look
 * "read" whether the panel previewed it or the browser tabbed away.
 */
export function ClusterArticleRow({
  article,
  isNew = false,
  isActive = false,
  isHighlighted = false,
  onConsume,
  onPreview,
}: {
  article: Article;
  /** Not yet read in this session — drives the blue dot. */
  isNew?: boolean;
  /** True when this article is the one shown in the detail panel. */
  isActive?: boolean;
  /** When ClusterCard renders all articles under an active filter
   *  ("view all" toggle on), the rows that actually match the filter are
   *  emphasized so the user can pick them out at a glance. The non-matching
   *  rows stay at their normal weight. */
  isHighlighted?: boolean;
  /** Fires on every click — modifier or not. */
  onConsume?: (articleId: number) => void;
  /** Fires only on a plain click. Parent shows the article in the panel. */
  onPreview?: (articleId: number) => void;
}) {
  const t = useTranslations("cluster");
  const locale = useLocale();
  const display = decodeHtmlEntities(
    article.title_normalized || article.title,
  );
  const time = fmtSmartClock(article.published_at, locale);

  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.stopPropagation();
        onConsume?.(article.id);
        const isModifier = e.metaKey || e.ctrlKey || e.shiftKey;
        if (isModifier) return; // let the browser open in a new tab
        e.preventDefault();
        onPreview?.(article.id);
      }}
      className={cn(
        "grid grid-cols-[14px_minmax(0,max-content)_auto_minmax(60px,1fr)_auto_auto]",
        "items-center gap-2",
        "px-3 py-2",
        "rounded",
        "text-[12.5px] no-underline",
        "transition-colors duration-100",
        // Precedence: active (article shown in detail panel) > highlighted
        // (matches the active filter in "view all" mode) > default. Bold
        // would clash with the convention "bold = unread" that webmail
        // clients have baked into users' eyes, so we lean on a subtle
        // background tint instead — neutral in tone, stable across light
        // and dark themes via a percentage overlay of the text color.
        isActive
          ? "bg-bg-sub"
          : isHighlighted
            ? "bg-[color-mix(in_oklab,var(--text)_5%,transparent)] hover:bg-[color-mix(in_oklab,var(--text)_8%,transparent)]"
            : "hover:bg-bg-hover",
      )}
    >
      {/* Marker — blue dot when the user hasn't clicked this row yet
          this session, plain bullet once consumed. */}
      <span className="flex items-center justify-center text-[11px] text-text-4">
        {isNew ? (
          <span
            className="w-2 h-2 rounded-full bg-new"
            title={t("new")}
          />
        ) : (
          <span className="leading-none">·</span>
        )}
      </span>

      {/* Source */}
      <span className="text-[11.5px] font-medium text-text-2 whitespace-nowrap">
        {article.source}
      </span>

      {/* Source-language chip — visible whenever the article's source
          language differs from the UI locale, regardless of whether a
          translation was actually substituted. This makes rows whose
          translation is still pending obviously different from
          fully-translated ones. */}
      {article.lang && article.lang !== locale ? (
        <Lang code={article.lang} />
      ) : (
        <span />
      )}

      {/* Title */}
      <span className="truncate text-text">{display}</span>

      {/* Treatment chip */}
      <TreatmentChip kind={article.article_type} />

      {/* Time */}
      <span className="font-mono tabular-nums text-[11px] text-text-3 whitespace-nowrap">
        {time}
      </span>
    </a>
  );
}
