"use client";

import * as React from "react";
import { ArrowLeft, ArrowUpRight, Copy, Share2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Lang, TreatmentChip } from "./_atoms";
import {
  ArticleCountriesBlock,
  ArticleEntitiesBlock,
  StoryCountriesBlock,
  StoryEntitiesBlock,
  StoryInfoStrip,
} from "./detail-panel-metadata";
import {
  aggregateStoryCountries,
  aggregateStoryEntities,
} from "@/lib/story-metadata";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  decodeHtmlEntities,
  earliestPublished,
  fmtClockParts,
  fmtSmartClock,
  latestPublished,
} from "@/lib/format";
import type { Article, Singleton, Story } from "@/lib/types";
import { useCategoryLabel } from "@/lib/use-category-label";
import { useChanged } from "@/lib/use-changed";

const PANEL_WIDTH = 480;

/**
 * Right slide-in detail panel.
 * Animates between width 0 (closed) and 480px (open).
 *
 * Render priority:
 *   1. `activeArticleId` (set when the user clicks an article inside a
 *      cluster expand) → ArticleDetail.
 *   2. `activeStoryId` resolved as a multi-source cluster → ClusterDetail.
 *   3. `activeStoryId` resolved as a singleton → ArticleDetail (singletons
 *      are just one-article stories from the panel's POV).
 *   4. Otherwise closed.
 *
 * Cluster view: header plus the Summary / Updates / Follow-up sections.
 * Article view (singleton or inside a cluster): header, hero image,
 *   summary, and a link out to the article.
 */
export function DetailPanel({
  stories,
  singletons,
  activeStoryId,
  activeArticleId,
  onClose,
  onBackToCluster,
  onShare,
}: {
  stories: Story[];
  singletons: Singleton[];
  activeStoryId: number | null;
  activeArticleId?: number | null;
  onClose: () => void;
  /** Fired when the user clicks the back arrow on an in-cluster article
   *  preview. Only forwarded down when the active article actually came
   *  from a cluster (not a true singleton). */
  onBackToCluster?: () => void;
  /** Opens the ShareModal for the cluster currently in view. Forwarded
   *  to `ClusterDetail` only — article-level views skip the share CTA
   *  (sharing happens at the cluster/story granularity, not per article;
   *  the Copy URL button next to "Lire l'article" handles the
   *  article-level use case). */
  onShare?: (storyId: number) => void;
}) {
  // Find the article we should preview (highest priority). Look in the
  // cluster articles first, then in standalone singletons — since both
  // arrays carry full Article objects, the panel only needs one. Track
  // whether the article came from a cluster: that controls whether the
  // header shows a back arrow.
  let activeArticle: Article | null = null;
  let articleFromCluster = false;
  if (activeArticleId !== null && activeArticleId !== undefined) {
    for (const s of stories) {
      const found = s.articles.find((a) => a.id === activeArticleId);
      if (found) {
        activeArticle = found;
        articleFromCluster = true;
        break;
      }
    }
    if (!activeArticle) {
      activeArticle =
        singletons.find((a) => a.id === activeArticleId) ?? null;
    }
  }

  const cluster =
    !activeArticle && activeStoryId !== null
      ? stories.find((s) => s.articles[0]?.story_id === activeStoryId)
      : undefined;
  const singleton =
    !activeArticle && !cluster && activeStoryId !== null
      ? singletons.find((s) => s.story_id === activeStoryId)
      : undefined;

  const isOpen = !!activeArticle || !!cluster || !!singleton;

  return (
    <aside
      aria-hidden={!isOpen}
      className={cn(
        "shrink-0 overflow-hidden bg-bg",
        "transition-[width] duration-[240ms] ease-out",
        "border-l",
        isOpen ? "border-border" : "border-transparent",
      )}
      style={{ width: isOpen ? PANEL_WIDTH : 0 }}
    >
      <div style={{ width: PANEL_WIDTH }} className="h-full">
        {activeArticle ? (
          <ArticleDetail
            article={activeArticle}
            onClose={onClose}
            onBack={articleFromCluster ? onBackToCluster : undefined}
          />
        ) : cluster ? (
          <ClusterDetail
            story={cluster}
            onClose={onClose}
            onShare={onShare}
          />
        ) : singleton ? (
          <ArticleDetail article={singleton} onClose={onClose} />
        ) : null}
      </div>
    </aside>
  );
}

/* ─────────── Cluster detail ─────────── */

function ClusterDetail({
  story,
  onClose,
  onShare,
}: {
  story: Story;
  onClose: () => void;
  /** Opens the ShareModal for this cluster. The button only renders
   *  when set — keeps the panel clean for callers that don't wire it
   *  (Library, Folder use the row-level RowActions instead). */
  onShare?: (storyId: number) => void;
}) {
  const t = useTranslations("detail");
  const tActions = useTranslations("actions");
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();
  const categories = (story.categories ?? []).filter(Boolean).map(categoryLabel);
  // Aggregate once at the parent so we can both decide whether to render
  // each Section and pass the data into its rendering component without
  // double-computing. `relevance.has*` are used as visibility gates; the
  // actual chip lists are computed again inside the block components
  // (cheap — same `Map` build under the hood).
  const aggEntities = React.useMemo(
    () => aggregateStoryEntities(story.articles),
    [story.articles],
  );
  const aggCountries = React.useMemo(
    () => aggregateStoryCountries(story.articles),
    [story.articles],
  );
  const hasEntities =
    aggEntities.persons.length +
      aggEntities.orgs.length +
      aggEntities.locations.length >
    0;
  const hasCountries = aggCountries.length > 0;
  const firstIso  = earliestPublished(story.articles);
  const firstTime = fmtSmartClock(firstIso, locale);
  const lastTime  = fmtSmartClock(latestPublished(story.articles), locale);

  // The cluster's story_id is the same across all its articles
  // (story_articles junction), so any article gives us the key.
  const storyId = story.articles[0]?.story_id;

  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        meta={
          <>
            {categories.length > 0 && (
              <span>{categories.join(" · ")}</span>
            )}
          </>
        }
        title={story.title}
        onClose={onClose}
        belowTitle={
          (firstTime || lastTime) ? (
            <div className="flex flex-col gap-1 text-[12px] text-text-3 pt-2">
              {firstTime && (
                <div className="flex items-center gap-2">
                  <span className="text-text-3">{t("firstArticle")}</span>
                  <span className="font-mono tabular-nums text-text-2">{firstTime}</span>
                </div>
              )}
              {lastTime && lastTime !== firstTime && (
                <div className="flex items-center gap-2">
                  <span className="text-text-3">{t("lastArticle")}</span>
                  <span className="font-mono tabular-nums text-text-2">{lastTime}</span>
                </div>
              )}
            </div>
          ) : null
        }
      />

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {story.synthesis && (
          <Section title={t("synthesis")}>
            <p className="text-[13px] leading-relaxed text-text-1 whitespace-pre-line">
              {story.synthesis}
            </p>
          </Section>
        )}

        <Section title={t("updates")}>
          {(story.updates && story.updates.length > 0) || story.origin ? (
            <UpdatesTimeline
              updates={story.updates ?? []}
              origin={story.origin ?? null}
              originIso={firstIso}
              locale={locale}
            />
          ) : (
            <Placeholder>{t("updatesPlaceholder")}</Placeholder>
          )}
        </Section>

        {/* Entities — aggregated from visible articles with the
         *  ≥2-articles rule (≥1 on tiny clusters), capped at top 10
         *  per category. Hidden when nothing meets the threshold. */}
        {hasEntities && (
          <Section title={t("entities")}>
            <StoryEntitiesBlock articles={story.articles} />
          </Section>
        )}

        {/* Countries — same threshold rule. */}
        {hasCountries && (
          <Section title={t("countries")}>
            <StoryCountriesBlock articles={story.articles} />
          </Section>
        )}

        {/* Info strip — article count, lifecycle status, age. Sits
         *  before the Share CTA so the share moment ends the scroll. */}
        <StoryInfoStrip
          nArticles={story.articles.length}
          status={story.status ?? null}
          startedAt={firstIso}
        />

        {/* Share CTA — sits at the end of the scroll content so the
         *  user reads the synthesis + timeline first, then is offered
         *  the action when engagement is highest. Mirrors the share
         *  button in RowActions but is more discoverable for users
         *  inside the panel. */}
        {onShare && storyId !== undefined && (
          <div className="pt-2 border-t border-border">
            <button
              type="button"
              onClick={() => onShare(storyId)}
              className={cn(
                "w-full inline-flex items-center justify-center gap-2",
                "px-3 py-2 rounded-md cursor-pointer",
                "border border-border bg-bg-elev",
                "text-[12.5px] font-medium text-text-2",
                "hover:bg-bg-hover hover:text-text hover:border-border-strong",
                "transition-colors",
              )}
            >
              <Share2 size={13} strokeWidth={1.7} aria-hidden />
              <span>{tActions("share")}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Build the displayable byline from the article's raw RSS author fields.
 *
 * `author` is feedparser's single-string `<author>` / `<dc:creator>`.
 * `authors` is the repeated Atom `<author><name>X</name></author>` shape
 * (= list of {name, email?, href?}). The two can both be populated, both
 * empty, or one or the other. We:
 *   1. Collect names from `authors[]` first (= more structured signal)
 *   2. Fall back to `author` (single string) only when `authors[]` is empty
 *   3. Dedupe case-insensitively so "AFP" and "afp" don't both show
 *
 * Returns the joined display string or null when there's no byline at all.
 * The byline is shown raw (no wire/publisher classification), so odd
 * values such as publisher names or wire credits stay visible as such.
 */
function articleByline(article: Article): string | null {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const a of article.authors ?? []) {
    const name = (a?.name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  // If `authors[]` produced nothing, try the single-string `author` field.
  // Don't merge them when `authors[]` worked — that's the structured shape
  // and `author` is often just `authors[0].name` echoed back as a string.
  if (out.length === 0) {
    const single = (article.author ?? "").trim();
    if (single) out.push(single);
  }

  return out.length > 0 ? out.join(", ") : null;
}

/* ─────────── Article detail ─────────── */
/* Shared between true singletons and articles previewed from a cluster. */

function ArticleDetail({
  article,
  onClose,
  onBack,
}: {
  article: Article;
  onClose: () => void;
  /** When set, the header renders a back arrow that pops back to the
   *  parent cluster's overview. Omitted for true singletons. */
  onBack?: () => void;
}) {
  const t = useTranslations("detail");
  const tActions = useTranslations("actions");
  const toast = useToast();
  const locale = useLocale();
  const categoryLabel = useCategoryLabel();
  // The LLM normalizer often tags articles with 1-3 categories; the
  // detail panel has room to show them all, joined like the feeds list.
  // Capped at 3 to keep the meta row sane if the model gets chatty.
  const categories = (article.category ?? [])
    .filter((c) => c && c !== "Other")
    .slice(0, 3)
    .map(categoryLabel);
  const time = fmtSmartClock(article.published_at, locale);

  /** Copy the article's source URL to the clipboard. Plain-text only —
   *  no need for HTML formatting on a single link. Toast confirms. */
  const handleCopyLink = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(article.url);
      toast.show(tActions("copied"));
    } catch (err) {
      console.error("clipboard copy failed", err);
      toast.show(tActions("copyFailed"), "error");
    }
  }, [article.url, toast, tActions]);

  // Translated (or LLM-cleaned source) view.
  const translatedTitle = article.title_normalized || article.title;
  // Raw RSS title — preserves the source script (e.g. Japanese kanji).
  // This is the only field that survives the loader's title resolution
  // unchanged, so we can show the article's actual original headline.
  const originalTitle = article.title;

  // Toggle controls whether we show the translated view or the raw source.
  // Reset whenever the article changes — opening a new article shouldn't
  // inherit the previous one's preference.
  const [showOriginal, setShowOriginal] = React.useState(false);
  if (useChanged(article.id)) setShowOriginal(false);

  const canToggle = article.title_is_translated === true;
  const rawTitle = canToggle && showOriginal ? originalTitle : translatedTitle;
  const rawSummary =
    canToggle && showOriginal
      ? article.summary || article.summary_normalized || ""
      : article.summary_normalized || article.summary || "";
  // Decode HTML entities once at the boundary — covers double-encoded
  // RSS feeds that slip through feedparser's first decoding pass.
  const displayTitle = decodeHtmlEntities(rawTitle);
  const displaySummary = decodeHtmlEntities(rawSummary);

  // Use the per-feed list when the backend provides it; fall back to the
  // single canonical source name when `feeds` is absent.
  const feedNames =
    article.feeds && article.feeds.length > 0
      ? article.feeds.map((f) => f.name)
      : [article.feed_name || article.source];

  // Byline — null when the article has no author info at all (= we hide
  // the row entirely rather than render an empty "By —"). Surfaced raw
  // from the RSS fields, with no wire/publisher classification.
  const byline = articleByline(article);

  const hasSecondRow = !!article.article_type || categories.length > 0;

  // Localized full-name of the source language ("français", "anglais",
  // "japonais"…). Falls back to the raw ISO code if the platform's
  // Intl.DisplayNames doesn't know it. Rendered for EVERY article that
  // has a detected lang (including ones matching the UI locale), because
  // readers don't all know 2-letter language codes.
  const sourceLangLabel = React.useMemo(() => {
    if (!article.lang) return null;
    try {
      const dn = new Intl.DisplayNames([locale], { type: "language" });
      return dn.of(article.lang) ?? article.lang.toUpperCase();
    } catch {
      return article.lang.toUpperCase();
    }
  }, [article.lang, locale]);

  const langLabelRow = sourceLangLabel ? (
    <div className="text-[11.5px] text-text-3 truncate">
      {t("originalLanguage", { language: sourceLangLabel })}
    </div>
  ) : null;

  const toggleButton = canToggle ? (
    <button
      type="button"
      onClick={() => setShowOriginal((s) => !s)}
      className="
        inline-flex items-center gap-1 text-[11.5px] font-medium
        text-text-3 hover:text-text underline-offset-2 hover:underline
        cursor-pointer
      "
    >
      {showOriginal ? t("showTranslation") : t("showOriginal")}
      <span className="text-[10px] uppercase tracking-wide text-text-4">
        {showOriginal ? locale.toUpperCase() : article.lang?.toUpperCase()}
      </span>
    </button>
  ) : null;

  // Stack the "Langue originale : X" line right above the
  // showOriginal/showTranslation toggle. If the toggle isn't present
  // (no translation available) we still surface the lang label.
  const headerBelowTitle = (langLabelRow || toggleButton) ? (
    <div className="flex flex-col gap-1">
      {langLabelRow}
      {toggleButton}
    </div>
  ) : null;

  return (
    <div className="h-full flex flex-col">
      <DetailHeader
        onBack={onBack}
        meta={
          <div className="flex flex-col gap-1 w-full min-w-0">
            {/* Row 1 — provenance & timestamp */}
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="font-semibold text-text truncate"
                title={feedNames.join(" · ")}
              >
                {feedNames.join(" · ")}
              </span>
              {/* Source-language chip — visible whenever the article's
                  source language differs from the UI locale (see
                  cluster-article-row). */}
              {article.lang && article.lang !== locale && (
                <>
                  <Sep />
                  <Lang code={article.lang} />
                </>
              )}
              {time && (
                <>
                  <Sep />
                  <span className="font-mono tabular-nums text-text-3 ml-auto pl-2">
                    {time}
                  </span>
                </>
              )}
            </div>

            {/* Row 2 — byline (= raw RSS author/authors fields).
             *  Surfaces fake bylines and wire credits explicitly so they
             *  show up at a glance in the panel rather than getting lost
             *  in the back-end. Hidden when the article has no byline. */}
            {byline && (
              <div className="text-[11.5px] text-text-3 truncate">
                {t("byline", { names: byline })}
              </div>
            )}

            {/* Row 3 — taxonomy: treatment + categories */}
            {hasSecondRow && (
              <div className="flex items-center gap-1.5 min-w-0">
                {article.article_type && (
                  <TreatmentChip kind={article.article_type} />
                )}
                {article.article_type && categories.length > 0 && <Sep />}
                {categories.length > 0 && (
                  <span className="truncate">{categories.join(" · ")}</span>
                )}
              </div>
            )}

          </div>
        }
        title={displayTitle}
        onClose={onClose}
        belowTitle={headerBelowTitle}
      />

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {article.image_url && (
          <ArticleImage src={article.image_url} alt={displayTitle} />
        )}

        {displaySummary && (
          <p className="text-[13.5px] leading-[1.55] text-text-2">
            {displaySummary}
          </p>
        )}

        <div className="inline-flex items-center gap-2">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-accent-text hover:underline"
          >
            {t("readArticle")}
            <ArrowUpRight size={12} />
          </a>
          <button
            type="button"
            onClick={handleCopyLink}
            title={t("copyLink")}
            aria-label={t("copyLink")}
            className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-3 hover:bg-bg-hover hover:text-text cursor-pointer transition-colors"
          >
            <Copy size={12} strokeWidth={1.7} aria-hidden />
          </button>
        </div>

        {/* Article-level entities — canonical Wikidata-linked entities
         *  (flat LinkedEntity[] list). The block renders
         *  only when the article has at least one resolved entity. */}
        {article.entities && article.entities.length > 0 && (
          <div className="pt-2 space-y-3">
            <Section title={t("entities")}>
              <ArticleEntitiesBlock entities={article.entities} />
            </Section>
          </div>
        )}

        {article.countries && article.countries.length > 0 && (
          <div className="pt-2">
            <Section title={t("countries")}>
              <ArticleCountriesBlock countries={article.countries} />
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hero image for the detail panel. Plain <img> rather than next/image so
 * we don't have to whitelist every feed's CDN in next.config.
 *
 * Two UX details when the user switches articles:
 *  1. `key={src}` forces React to unmount the old <img> and mount a fresh
 *     one — no leftover pixels from the previous article during fetch.
 *  2. Opacity is gated on `onLoad`: the image fades in once decoded, so
 *     the user sees the neutral container bg during the swap rather than
 *     a half-painted image.
 *  Hides silently on error (404, hot-link block, etc.) — a broken-image
 *  icon would feel worse than no image at all.
 */
function ArticleImage({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = React.useState<"loading" | "loaded" | "error">(
    "loading",
  );

  // Reset on src change — without this the loaded/error state from the
  // previous article would leak into the new one. During render, so the
  // previous image is never briefly shown as loaded under a new src.
  if (useChanged(src)) setState("loading");

  if (state === "error") return null;

  return (
    <div className="aspect-video w-full overflow-hidden rounded-md bg-bg-sub border border-border">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        src={src}
        alt={alt}
        loading="lazy"
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
        className={cn(
          "w-full h-full object-cover transition-opacity duration-200",
          state === "loaded" ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/* ─────────── Shared sub-components ─────────── */

function DetailHeader({
  meta,
  title,
  onClose,
  onBack,
  belowTitle,
}: {
  meta: React.ReactNode;
  title: string;
  onClose: () => void;
  /** When set, renders an ArrowLeft on the far left of the header.
   *  Used for in-cluster article previews to pop back to the cluster. */
  onBack?: () => void;
  /** Optional slot rendered just under the title, still INSIDE the header
   *  block (i.e. above the divider). ArticleDetail uses this for its
   *  "Voir l'original" toggle. */
  belowTitle?: React.ReactNode;
}) {
  const t = useTranslations();
  return (
    <div className="sticky top-0 z-[2] bg-bg border-b border-border shrink-0">
      {/* Top row: navigation controls only — keeps the meta+title block
          below at full panel width so long source/category strings don't
          wrap into 4 lines next to the icons. */}
      <div className="flex items-center justify-between px-2 pt-2">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("detail.backToCluster")}
            title={t("detail.backToCluster")}
            className="
              inline-flex items-center justify-center
              h-7 w-7 rounded-md
              text-text-3 hover:text-text hover:bg-bg-hover
              transition-colors cursor-pointer
            "
          >
            <ArrowLeft size={14} />
          </button>
        ) : (
          <span className="h-7 w-7" aria-hidden />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="
            inline-flex items-center justify-center
            h-7 w-7 rounded-md
            text-text-3 hover:text-text hover:bg-bg-hover
            transition-colors cursor-pointer
          "
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 pb-3">
        <div className="flex items-center gap-1.5 mb-1.5 text-[11px] text-text-3">
          {meta}
        </div>
        <h2 className="text-[15px] font-semibold tracking-[-0.012em] leading-[1.3] text-text [text-wrap:pretty]">
          {title}
        </h2>
        {belowTitle && <div className="mt-2">{belowTitle}</div>}
      </div>
    </div>
  );
}

/**
 * Reverse-chrono timeline for cluster updates (mirrors the design handoff).
 * One row per entry with [dot] [stacked time] [content].
 *
 * Time column is stacked (day label above clock) for compactness — keeps
 * the column narrow even when the day label is "yesterday" / "Wednesday".
 * For today's entries, the day line is omitted and only the clock shows.
 *
 * Three dot styles mark the row's role in the timeline:
 *   - latest  → filled accent + soft halo (hot signal)
 *   - muted   → hollow ring (older updates)
 *   - origin  → filled neutral gray (genesis anchor at the foundation)
 *
 * The vertical guide line is drawn per-row as a connector going from this
 * row's dot down to the next row's dot center. The last row (origin, or
 * the last update if no origin exists) renders no connector, so the line
 * naturally ends right at the last dot — no trailing whitespace.
 */
function UpdatesTimeline({
  updates,
  origin,
  originIso,
  locale,
}: {
  updates: { content: string; added_at: string }[];
  origin: string | null;
  originIso: string | null;
  locale: string;
}) {
  type Row = { iso: string | null; content: string; variant: RowVariant };
  const rows: Row[] = [
    ...updates.map<Row>((u, i) => ({
      iso: u.added_at,
      content: u.content,
      variant: i === 0 ? "latest" : "muted",
    })),
    ...(origin
      ? [{ iso: originIso, content: origin, variant: "origin" as const }]
      : []),
  ];

  return (
    <div>
      {rows.map((row, i) => (
        <TimelineRow
          key={i}
          iso={row.iso}
          content={row.content}
          variant={row.variant}
          hasNext={i < rows.length - 1}
          locale={locale}
        />
      ))}
    </div>
  );
}

type RowVariant = "latest" | "muted" | "origin";

function TimelineRow({
  iso,
  content,
  variant,
  hasNext,
  locale,
}: {
  iso: string | null;
  content: string;
  variant: RowVariant;
  hasNext: boolean;
  locale: string;
}) {
  const parts = iso ? fmtClockParts(iso, locale) : { day: null, clock: "" };
  const hasTime = parts.clock !== "";
  const isLatest = variant === "latest";

  const dotClass =
    variant === "latest"
      ? "bg-accent border-accent shadow-[0_0_0_3px_var(--accent-soft)]"
      : variant === "origin"
        ? "bg-text-2 border-text-2"
        : "bg-bg border-border-strong";

  return (
    <div className="relative grid grid-cols-[auto_auto_1fr] items-baseline gap-x-3 py-1.5">
      {/* Connector line from this row's dot down to the next row's dot
          center (-12.5px past row bottom, since the next row's dot center
          sits at py-1.5 (6px) + translate-y (2px) + half dot height (4.5px)
          = 12.5px from its row's top). */}
      {hasNext && (
        <span
          aria-hidden
          className="absolute left-[4px] top-[17px] w-px bg-border"
          style={{ bottom: "-13px" }}
        />
      )}
      <span
        aria-hidden
        className={cn(
          "relative z-[1] h-[9px] w-[9px] shrink-0 rounded-full border-2 translate-y-[2px]",
          dotClass,
        )}
      />
      {hasTime ? (
        <span
          className={cn(
            "font-mono tabular-nums whitespace-nowrap flex flex-col items-start leading-tight",
            isLatest ? "text-accent-text" : "text-text-3",
          )}
        >
          {parts.day && (
            <span className="text-[10px] font-medium">{parts.day}</span>
          )}
          <span
            className={cn(
              "text-[11px]",
              isLatest ? "font-semibold" : "font-medium",
            )}
          >
            {parts.clock}
          </span>
        </span>
      ) : (
        <span aria-hidden />
      )}
      <span
        className={cn(
          "text-[13px] leading-[1.5]",
          isLatest ? "text-text font-medium" : "text-text-2",
        )}
      >
        {content}
      </span>
    </div>
  );
}


function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2.5 mb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-2 shrink-0">
          {title}
        </h3>
        <span className="flex-1 h-px bg-border" />
      </div>
      {children}
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 rounded-md bg-bg-sub border border-dashed border-border-strong text-[12px] text-text-3">
      {children}
    </div>
  );
}

function Sep() {
  return <span className="text-text-4">·</span>;
}
