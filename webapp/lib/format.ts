/**
 * Formatting helpers — relative time, country → region, date helpers.
 *
 * Locale handling: every formatter takes a locale (BCP-47 string, e.g.
 * "en" / "fr"). We delegate to `Intl.DateTimeFormat(locale, …)` which
 * handles month names, weekday names, AM/PM, etc. automatically. The
 * timezone follows the browser's locale (we do NOT pin one).
 *
 * For sentence-level labels that aren't covered by Intl ("yesterday",
 * "just now", "today"), we ship a small inline dictionary keyed by the
 * locale's first segment ("en", "fr"). Adding a new locale = adding a
 * row + a JSON file in `messages/`.
 */

/**
 * Parse an ISO timestamp safely.
 *
 * Backend currently emits timestamps without any timezone designator
 * (e.g. "2026-05-04T10:48:49.706602") even though the underlying value
 * is UTC. Native `new Date(iso)` then interprets it as LOCAL time —
 * shifting the formatted output by the user's TZ offset.
 *
 * This helper appends "Z" when no offset is present, so the resulting
 * Date is anchored at the right absolute instant before we format it.
 */
function parseDate(iso: string): Date {
  // Already has a tz designator (Z or ±HH:MM)? Use as-is.
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) return new Date(iso);
  return new Date(iso + "Z");
}

// ---------------------------------------------------------------------------
// Locale resources
// ---------------------------------------------------------------------------

interface RelativeLabels {
  justNow: string;
  today: string;
  yesterday: string;
}

const LABELS: Record<string, RelativeLabels> = {
  en: { justNow: "just now", today: "Today", yesterday: "Yesterday" },
  fr: { justNow: "à l'instant", today: "Aujourd'hui", yesterday: "Hier" },
};

function langOf(locale: string): "en" | "fr" {
  const head = (locale ?? "").toLowerCase().split("-")[0];
  return head === "fr" ? "fr" : "en";
}

function labelsFor(locale: string): RelativeLabels {
  return LABELS[langOf(locale)] ?? LABELS.en;
}

// Per-locale formatter cache. Intl.DateTimeFormat creation is non-trivial,
// and these helpers are called many times per render — cache once.
type Fmt = Intl.DateTimeFormat;
const _cache: Record<string, {
  clock: Fmt;
  weekday: Fmt;
  weekdayClock: Fmt;
  shortDate: Fmt;
  shortDateYear: Fmt;
}> = {};

function fmts(locale: string) {
  const key = langOf(locale); // collapse to "en" | "fr"
  if (_cache[key]) return _cache[key];
  // BCP-47 locale tag — "fr-FR" gives French formatting; "en" gives the
  // browser's default English (US conventions). Good enough for MVP.
  const tag = key === "fr" ? "fr-FR" : "en-US";
  const made = {
    clock:         new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }),
    weekday:       new Intl.DateTimeFormat(tag, { weekday: "short" }),
    weekdayClock:  new Intl.DateTimeFormat(tag, { weekday: "short", hour: "2-digit", minute: "2-digit" }),
    shortDate:     new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" }),
    shortDateYear: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric" }),
  };
  _cache[key] = made;
  return made;
}

/**
 * Day delta between two dates in the visitor's local timezone (ignores HH:MM).
 * 0 = same calendar day, 1 = yesterday, -1 = tomorrow.
 */
function _dayDelta(d: Date, now: Date): number {
  const day = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  const a = day(d);
  const b = day(now);
  const aMs = new Date(a + "T00:00:00Z").getTime();
  const bMs = new Date(b + "T00:00:00Z").getTime();
  return Math.round((bMs - aMs) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Time formatters
// ---------------------------------------------------------------------------

/**
 * Compact relative time.
 *   < 5s      labels.justNow
 *   < 60s     "12s"
 *   < 60min   "12 min"
 *   < 24h     "3h"
 *   < 7d      weekday + clock — disambiguates "Xj"
 *   same year short date ("29 Apr." / "29 avr.")
 *   else      short date with year
 */
export function fmtRelative(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const d = parseDate(iso);
  if (isNaN(d.getTime())) return "";

  const f = fmts(locale);
  const lbl = labelsFor(locale);

  const secs = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  if (secs <= 5) return lbl.justNow;
  if (secs < 60) return `${secs}s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;

  const delta = _dayDelta(d, now);
  if (delta < 7) return f.weekdayClock.format(d);

  const year = (fmt: Intl.DateTimeFormat) =>
    parseInt(
      fmt.formatToParts(d).find((p) => p.type === "year")!.value,
      10,
    );
  const sameYear = year(f.shortDateYear) === year2(f.shortDateYear, now);
  return sameYear ? f.shortDate.format(d) : f.shortDateYear.format(d);
}

function year2(fmt: Intl.DateTimeFormat, when: Date): number {
  return parseInt(
    fmt.formatToParts(when).find((p) => p.type === "year")!.value,
    10,
  );
}

/**
 * Smart clock — for per-article timestamps inside a cluster expand.
 *   Today        "14:32"
 *   Yesterday    "yesterday 14:32" / "hier 14:32"
 *   This week    "Mon 14:32" / "lun. 14:32"   (2-6 days ago)
 *   Older        "29 Apr 14:32" / "29 avr. 14:32"
 */
export function fmtSmartClock(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const d = parseDate(iso);
  if (isNaN(d.getTime())) return "";

  const f = fmts(locale);
  const lbl = labelsFor(locale);
  const clock = f.clock.format(d);
  const delta = _dayDelta(d, now);

  if (delta <= 0) return clock;
  if (delta === 1) return `${lbl.yesterday.toLowerCase()} ${clock}`;
  if (delta < 7) return `${f.weekday.format(d)} ${clock}`;
  return `${f.shortDate.format(d)} ${clock}`;
}

/**
 * Decode the most common HTML entities in user-visible strings.
 *
 * Some RSS feeds (BFMTV, etc.) double-encode their HTML, so even after
 * feedparser's first pass we still see literals like `&quot;` and
 * `&#039;` in raw `title` / `summary` fields. This helper covers the
 * 7 entities responsible for >99% of cases — anything more exotic
 * would call for a real DOM parser, overkill at this scale.
 *
 * Order matters: `&amp;` is decoded last so we don't double-decode
 * sequences like `&amp;quot;`.
 */
export function decodeHtmlEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Split version of `fmtSmartClock` for stacked timestamp rendering
 * (event-log style: day label above clock).
 *   Today        { day: null,        clock: "14:32" }
 *   Yesterday    { day: "yesterday", clock: "14:32" }   /  { day: "hier", clock }
 *   This week    { day: "Mon",       clock: "14:32" }   /  { day: "lun.", clock }
 *   Older        { day: "29 Apr",    clock: "14:32" }   /  { day: "29 avr.", clock }
 *
 * `day` is intentionally null for today so the renderer can collapse the
 * extra line and show just the clock, which keeps the timeline column
 * narrow and consistent.
 */
export function fmtClockParts(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): { day: string | null; clock: string } {
  if (!iso) return { day: null, clock: "" };
  const d = parseDate(iso);
  if (isNaN(d.getTime())) return { day: null, clock: "" };

  const f = fmts(locale);
  const lbl = labelsFor(locale);
  const clock = f.clock.format(d);
  const delta = _dayDelta(d, now);

  if (delta <= 0) return { day: null, clock };
  if (delta === 1) return { day: lbl.yesterday.toLowerCase(), clock };
  if (delta < 7) return { day: f.weekday.format(d), clock };
  return { day: f.shortDate.format(d), clock };
}

/**
 * Always include date + time. Used in /library where cards may span any
 * point in the past — a bare "14:32" with no date is disorienting once
 * you scroll past today.
 *   Today        "Today 14:32" / "Aujourd'hui 14:32"
 *   Yesterday    "Yesterday 14:32" / "Hier 14:32"
 *   This year    "5 May 14:32" / "5 mai 14:32"
 *   Older        "5 May 2025 14:32" / "5 mai 2025 14:32"
 */
export function fmtAbsolute(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const d = parseDate(iso);
  if (isNaN(d.getTime())) return "";

  const f = fmts(locale);
  const lbl = labelsFor(locale);
  const clock = f.clock.format(d);
  const delta = _dayDelta(d, now);
  if (delta === 0) return `${lbl.today} ${clock}`;
  if (delta === 1) return `${lbl.yesterday} ${clock}`;

  const year = (when: Date) =>
    parseInt(
      f.shortDateYear.formatToParts(when).find((p) => p.type === "year")!.value,
      10,
    );
  const sameYear = year(d) === year(now);
  return sameYear
    ? `${f.shortDate.format(d)} ${clock}`
    : `${f.shortDateYear.format(d)} ${clock}`;
}

/**
 * The day heading a timestamp belongs under in a feed.
 *
 * Returns a stable `key` and a display `label`: headings are compared by
 * one piece of code and rendered by another, and comparing translated
 * strings would merge two days the moment a locale spelled them alike.
 *
 * Computed in the browser on purpose: where "today" ends depends on the
 * reader's timezone, which the server does not know.
 */
export function dayBucket(
  iso: string | null | undefined,
  locale: string,
  now: Date = new Date(),
): { key: string; label: string } {
  const d = parseDate(iso ?? "");
  if (isNaN(d.getTime())) return { key: "unknown", label: "—" };

  const f = fmts(locale);
  const lbl = labelsFor(locale);
  const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  const delta = _dayDelta(d, now);
  if (delta === 0) return { key, label: lbl.today };
  if (delta === 1) return { key, label: lbl.yesterday };

  const sameYear = d.getFullYear() === now.getFullYear();
  return {
    key,
    label: sameYear ? f.shortDate.format(d) : f.shortDateYear.format(d),
  };
}

// ---------------------------------------------------------------------------
// Country / region helpers (locale-independent for now — labels come from
// Intl.DisplayNames if available)
// ---------------------------------------------------------------------------
//
// All maps are imported from `taxonomy.generated.ts`, which is auto-generated
// from `src/taxonomy.py` by `scripts/sync_taxonomy.py`. The Python module is
// the SINGLE source of truth — the worker (normalizer and extractor
// prompts) reads it directly, the frontend reads the generated TS. Edit
// taxonomy.py, run the script, both sides stay in sync. DO NOT add new
// country/region mappings here.

import {
  COUNTRY_CODES as _COUNTRY_CODES,
  COUNTRY_TO_BROAD,
  COUNTRY_TO_REGION,
  GLOBAL_CODE,
  GLOBAL_LABELS,
  REGIONAL_LABELS,
  REGION_BUCKETS,
  REGION_BUCKET_LABELS,
  REGION_MEMBERS,
} from "./taxonomy.generated";

// Re-export under the historical name expected by the SPA filters.
export const COUNTRY_CODES = _COUNTRY_CODES;
export const REGION_ORDER = REGION_BUCKETS;

/**
 * Expand a list of user-selected place codes to include their broad
 * ancestors (countries → containing region) AND their members (region
 * → child countries). The result is the full set the filter pipeline
 * should accept as a match against `article.countries`.
 *
 *   ["FR"]        → { "FR", "EU" }
 *   ["EU"]        → { "EU", "FR", "DE", "IT", ... all European countries }
 *   ["FR", "AS"]  → { "FR", "EU", "AS", "CN", "JP", ... }
 *
 * Unknown codes pass through unchanged (free-text place names from
 * `entities.locations`, US/CA without a broad ancestor, etc.).
 */
/**
 * One-way expansion: each input code is kept verbatim, and broad codes
 * additionally expand to their child countries. Country codes do NOT
 * expand to their broad ancestor — picking "Malte" must match Malta-
 * tagged articles only, never the full EU bucket.
 *
 *   ["MT"]        → { "MT" }
 *   ["EU"]        → { "EU", "FR", "DE", "IT", ... all European countries }
 *   ["FR", "AS"]  → { "FR", "AS", "CN", "JP", ... }   // AS expands, FR doesn't
 *
 * Use this for `subjectCountries` matching (Advanced + sidebar Pays
 * concernés). The bilateral `expandPlaceCodes` above serves the `places`
 * filter only.
 */
export function expandBroadToChildren(codes: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = raw.toUpperCase();
    out.add(code);
    const children = REGION_MEMBERS[code];
    if (children) {
      for (const c of children) out.add(c);
    }
  }
  return out;
}

export function expandPlaceCodes(codes: string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of codes) {
    const code = raw.toUpperCase();
    out.add(code);
    // Country → broad ancestor
    const broad = COUNTRY_TO_BROAD[code];
    if (broad) out.add(broad);
    // Broad → all child countries
    const children = REGION_MEMBERS[code];
    if (children) {
      for (const c of children) out.add(c);
    }
    // Preserve the original casing too so free-text place names
    // ("Paris", "Davos") still match `entities.locations`.
    if (raw !== code) out.add(raw);
  }
  return out;
}

/** Bucket key for grouping (locale-independent). Use `regionLabel` to display. */
export function countryToRegion(code: string | null | undefined): string {
  if (!code) return "Other";
  return COUNTRY_TO_REGION[code.toUpperCase()] ?? "Other";
}

export function regionLabel(region: string, locale: string): string {
  const lang = langOf(locale) === "fr" ? "fr" : "en";
  const dict = REGION_BUCKET_LABELS[lang] ?? REGION_BUCKET_LABELS.en;
  return dict[region] ?? dict.Other ?? region;
}

/** Localized country name from ISO code (e.g. "FR" → "France" / "France"). */
const _displayNamesCache: Record<string, Intl.DisplayNames | null> = {};
function displayNames(locale: string): Intl.DisplayNames | null {
  const tag = langOf(locale) === "fr" ? "fr-FR" : "en-US";
  if (tag in _displayNamesCache) return _displayNamesCache[tag];
  try {
    const dn = new Intl.DisplayNames([tag], { type: "region" });
    _displayNamesCache[tag] = dn;
    return dn;
  } catch {
    _displayNamesCache[tag] = null;
    return null;
  }
}

export function countryLabel(
  code: string | null | undefined,
  locale: string,
): string {
  if (!code) return "";
  const c = code.toUpperCase();
  const lang = langOf(locale) === "fr" ? "fr" : "en";
  // 3-letter regional pseudo-codes (EUR/MID/ASI/AFR/LAT/OCE) — not ISO,
  // Intl.DisplayNames doesn't know them, so we render their localized
  // labels explicitly.
  const regional = REGIONAL_LABELS[c];
  if (regional) return lang === "fr" ? regional.fr : regional.en;
  // Global placeholder (GLB) — same rationale, distinct semantic from
  // the regional codes (worldwide scope, no specific region).
  if (c === GLOBAL_CODE) return lang === "fr" ? GLOBAL_LABELS.fr : GLOBAL_LABELS.en;
  // ISO alpha-2 → Intl.DisplayNames handles localization.
  const dn = displayNames(locale);
  if (!dn) return c;
  try {
    return dn.of(c) ?? c;
  } catch {
    return c;
  }
}

/** Localized language name from ISO code (e.g. "fr" → "Français" / "French"). */
const LANG_LABELS: Record<string, Record<string, string>> = {
  en: {
    fr: "French",
    en: "English",
    de: "German",
    es: "Spanish",
    it: "Italian",
    pt: "Portuguese",
    zh: "Chinese",
    ar: "Arabic",
    ru: "Russian",
    nl: "Dutch",
  },
  fr: {
    fr: "Français",
    en: "English",
    de: "Deutsch",
    es: "Español",
    it: "Italiano",
    pt: "Português",
    zh: "中文",
    ar: "العربية",
    ru: "Русский",
    nl: "Nederlands",
  },
};

export function langLabel(
  code: string | null | undefined,
  locale: string,
): string {
  if (!code) return "";
  const dict = LANG_LABELS[langOf(locale)] ?? LANG_LABELS.en;
  return dict[code] ?? code.toUpperCase();
}

// ---------------------------------------------------------------------------
// Article aggregations
// ---------------------------------------------------------------------------

export function dominantCategory(
  articles: { category: string[] }[],
): string | null {
  const counts: Record<string, number> = {};
  for (const a of articles) {
    for (const c of a.category ?? []) {
      counts[c] = (counts[c] ?? 0) + 1;
    }
  }
  let best: [string, number] | null = null;
  for (const [c, n] of Object.entries(counts)) {
    if (!best || n > best[1]) best = [c, n];
  }
  return best?.[0] ?? null;
}

export function latestPublished(
  articles: { published_at: string }[],
): string | null {
  let best: string | null = null;
  for (const a of articles) {
    if (!a.published_at) continue;
    if (!best || a.published_at > best) best = a.published_at;
  }
  return best;
}

export function earliestPublished(
  articles: { published_at: string }[],
): string | null {
  let best: string | null = null;
  for (const a of articles) {
    if (!a.published_at) continue;
    if (!best || a.published_at < best) best = a.published_at;
  }
  return best;
}

export function latestFetched(
  articles: { fetched_at: string }[],
): string | null {
  let best: string | null = null;
  for (const a of articles) {
    if (!a.fetched_at) continue;
    if (!best || a.fetched_at > best) best = a.fetched_at;
  }
  return best;
}
