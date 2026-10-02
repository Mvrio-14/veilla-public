import type { Singleton, Story } from "./types";

/**
 * Format a cluster or singleton as a portable rich-text block for
 * clipboard export. Returns both an HTML version (used by Slack, Gmail,
 * Notion, Google Docs when their paste handler accepts text/html) and a
 * plain-text fallback (used by terminals, plain editors, mail clients
 * in plain mode).
 *
 * The clipboard write puts both formats on simultaneously via
 * `ClipboardItem`. The destination picks whichever it understands at
 * paste-time — no choice exposed to the user.
 *
 * HTML strategy:
 *   - Semantic tags first (`<strong>`, `<em>`, `<ul>`, `<a>`) because
 *     Slack strips most CSS but renders semantic markup.
 *   - Inline styles second (font-family, colors, spacing) — bonus
 *     rendering for Gmail/Notion which preserve them.
 *   - No external stylesheet, no images — survives any destination.
 *
 * Footer link points at `${origin}/watch?story=${id}` so a recipient
 * already on Veilla can navigate back to the source cluster. Origin
 * is read from `window.location` at call-time so a localhost dev test
 * produces a localhost link (= clickable locally), while prod
 * naturally produces veilla.io links.
 *
 * This module runs outside React, so it does not read translations
 * itself: the caller passes the localized `labels` in.
 */
export function formatStoryForClipboard(
  item: Story | Singleton,
  labels: StoryExportLabels,
): { html: string; text: string } {
  if (isCluster(item)) return formatCluster(item, labels);
  return formatSingleton(item, labels);
}

/** Localized strings the export needs, built by the caller from the
 *  `storyExport` translation namespace. */
export interface StoryExportLabels {
  /** "Article: {time}" — the single timestamp line. */
  article: (time: string) => string;
  firstArticle: (time: string) => string;
  lastArticle: (time: string) => string;
  /** "Sources (N outlets)" heading. */
  sources: (count: number) => string;
  recentUpdates: string;
  /** Lead-in before the "Veilla…" link in the footer. */
  sharedFrom: string;
}

/**
 * Write the formatted story to the clipboard with rich-text (HTML) and
 * plain-text representations side-by-side. The browser dispatches the
 * right one at paste-time.
 *
 * Throws on Clipboard API failure (unsupported browser, insecure
 * origin, denied permission). Callers should catch and surface a
 * "copy failed" toast.
 */
export async function copyStoryToClipboard(
  item: Story | Singleton,
  labels: StoryExportLabels,
): Promise<void> {
  const { html, text } = formatStoryForClipboard(item, labels);
  const clipboardItem = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  });
  await navigator.clipboard.write([clipboardItem]);
}

/* ─────────── Internal helpers ─────────── */

function isCluster(item: Story | Singleton): item is Story {
  return (
    typeof item === "object" &&
    item !== null &&
    "articles" in item &&
    Array.isArray((item as Story).articles)
  );
}

function originSafe(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "https://veilla.io";
}

function formatCluster(
  story: Story,
  labels: StoryExportLabels,
): { html: string; text: string } {
  const articles = story.articles ?? [];
  const updates = story.updates ?? [];
  const storyId = articles[0]?.story_id;
  const veillaUrl = storyId
    ? `${originSafe()}/watch?story=${storyId}`
    : originSafe();
  const sourcesLabel = labels.sources(story.n_sources);

  // First / last article timestamps — gives the recipient a sense of
  // the news window the cluster covers. Skipped silently when the
  // cluster has no usable timestamps.
  const { firstIso, lastIso } = articleTimeRange(articles);
  const firstFmt = formatArticleTimestamp(firstIso);
  const lastFmt = formatArticleTimestamp(lastIso);
  const sameInstant =
    firstIso !== null && lastIso !== null && firstIso === lastIso;

  const timeRangeHtml =
    firstFmt && lastFmt
      ? sameInstant
        ? `<p style="margin:0 0 12px;font-size:12px;color:#666;">${escapeHtml(labels.article(firstFmt))}</p>`
        : `<p style="margin:0 0 12px;font-size:12px;color:#666;">${escapeHtml(labels.firstArticle(firstFmt))}<br>${escapeHtml(labels.lastArticle(lastFmt))}</p>`
      : "";

  const articleItemsHtml = articles
    .map((a) => {
      const title = a.title_normalized || a.title;
      return `<li><a href="${escapeAttr(a.url)}" style="color:#2563eb;">${escapeHtml(title)}</a> <span style="color:#888;">— ${escapeHtml(a.source)}</span></li>`;
    })
    .join("");

  const updatesBlockHtml = updates.length
    ? `<p style="margin:14px 0 4px;font-size:11px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(labels.recentUpdates)}</p>
<ul style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.5;">${updates
        .map((u) => `<li>${escapeHtml(u.content)}</li>`)
        .join("")}</ul>`
    : "";

  const synthesisBlockHtml = story.synthesis
    ? `<p style="margin:0 0 14px;color:#555;font-style:italic;font-size:13px;line-height:1.5;"><em>${escapeHtml(story.synthesis)}</em></p>`
    : "";

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;">
<p style="margin:0 0 8px;font-size:15px;font-weight:600;line-height:1.35;"><strong>${escapeHtml(story.title)}</strong></p>
${synthesisBlockHtml}
${timeRangeHtml}
<p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(sourcesLabel)}</p>
<ul style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.5;">${articleItemsHtml}</ul>
${updatesBlockHtml}
<p style="margin:0;font-size:11px;color:#888;">${escapeHtml(labels.sharedFrom)} <a href="${escapeAttr(veillaUrl)}" style="color:#888;">Veilla…</a></p>
</div>`;

  // Plain text fallback — readable in terminals, plain mail clients,
  // and as a defensive lower bound across any pasted destination.
  const lines: string[] = [story.title, ""];
  if (story.synthesis) {
    lines.push(story.synthesis, "");
  }
  if (firstFmt && lastFmt) {
    if (sameInstant) {
      lines.push(labels.article(firstFmt), "");
    } else {
      lines.push(labels.firstArticle(firstFmt));
      lines.push(labels.lastArticle(lastFmt), "");
    }
  }
  lines.push(sourcesLabel);
  for (const a of articles) {
    lines.push(`- ${a.title_normalized || a.title} (${a.source})`);
    lines.push(`  ${a.url}`);
  }
  if (updates.length) {
    lines.push("", labels.recentUpdates);
    for (const u of updates) lines.push(`- ${u.content}`);
  }
  lines.push("", `${labels.sharedFrom} Veilla… ${veillaUrl}`);

  return { html, text: lines.join("\n") };
}

function formatSingleton(
  article: Singleton,
  labels: StoryExportLabels,
): { html: string; text: string } {
  const title = article.title_normalized || article.title;
  const veillaUrl = article.story_id
    ? `${originSafe()}/watch?story=${article.story_id}`
    : originSafe();
  const articleTime = formatArticleTimestamp(article.published_at ?? null);

  const timeHtml = articleTime
    ? `<p style="margin:0 0 12px;font-size:12px;color:#666;">${escapeHtml(labels.article(articleTime))}</p>`
    : "";

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:640px;">
<p style="margin:0 0 8px;font-size:15px;font-weight:600;"><strong>${escapeHtml(title)}</strong></p>
${timeHtml}
<p style="margin:0 0 14px;font-size:13px;"><a href="${escapeAttr(article.url)}" style="color:#2563eb;">${escapeHtml(article.source)}</a></p>
<p style="margin:0;font-size:11px;color:#888;">${escapeHtml(labels.sharedFrom)} <a href="${escapeAttr(veillaUrl)}" style="color:#888;">Veilla…</a></p>
</div>`;

  const lines: string[] = [title, ""];
  if (articleTime) lines.push(labels.article(articleTime), "");
  lines.push(`${article.source} — ${article.url}`);
  lines.push("", `${labels.sharedFrom} Veilla… ${veillaUrl}`);

  return { html, text: lines.join("\n") };
}

/** Pick the earliest and latest article publish timestamps from a
 *  cluster. Falls back to fetched_at when the feed didn't provide a
 *  pubdate (some feeds skip it). Returns nulls when no article carries
 *  a usable timestamp at all. */
function articleTimeRange(articles: Singleton[]): {
  firstIso: string | null;
  lastIso: string | null;
} {
  let firstIso: string | null = null;
  let lastIso: string | null = null;
  for (const a of articles) {
    const iso = a.published_at || a.fetched_at;
    if (!iso) continue;
    if (firstIso === null || iso < firstIso) firstIso = iso;
    if (lastIso === null || iso > lastIso) lastIso = iso;
  }
  return { firstIso, lastIso };
}

/** Format an ISO timestamp as a human-readable absolute date+time using
 *  the runtime locale (browser at click-time). Returns null on bad
 *  input so the caller can drop the line silently. */
function formatArticleTimestamp(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
