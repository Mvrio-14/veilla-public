/**
 * Granularity utilities for the Library timeline grouping.
 *
 * The Library shows saved stories sectioned by date with a "zoom level"
 * tab selector (Day / Week / Month / Year / All). This module turns a
 * story's `saved_at` ISO string into:
 *   - a stable key per granularity (used to group),
 *   - a localized label per granularity (used as the section header).
 *
 * Pattern inspired by Apple Photos: the tabs don't FILTER, they just
 * change how the same set is chunked visually.
 */

export type Granularity = "day" | "week" | "month" | "year" | "all";

export const GRANULARITY_ORDER: Granularity[] = [
  "day",
  "week",
  "month",
  "year",
  "all",
];

/** Stable group key for `iso` at the chosen granularity.
 *  Empty string means "no grouping" (all granularity = single section). */
export function granularityKey(iso: string, gran: Granularity): string {
  if (gran === "all") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  switch (gran) {
    case "day":
      return ymd(d);
    case "week":
      return ymd(startOfIsoWeek(d));
    case "month":
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
    case "year":
      return String(d.getUTCFullYear());
  }
}

/** Localized section header for a key produced by `granularityKey`.
 *  `now` allows callers to inject a clock for "Today" / "Yesterday" labels;
 *  defaults to `new Date()`. */
export function granularityLabel(
  key: string,
  gran: Granularity,
  locale: string,
  now: Date = new Date(),
): string {
  if (gran === "all" || !key) return "";

  const isFr = (locale ?? "").toLowerCase().startsWith("fr");

  switch (gran) {
    case "day": {
      const d = parseYmd(key);
      if (!d) return key;
      // Today / Yesterday shortcuts for the most recent days.
      const today = ymd(now);
      const yesterday = ymd(addDays(now, -1));
      if (key === today) return isFr ? "Aujourd'hui" : "Today";
      if (key === yesterday) return isFr ? "Hier" : "Yesterday";
      return cap(
        new Intl.DateTimeFormat(locale, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: d.getUTCFullYear() !== now.getUTCFullYear() ? "numeric" : undefined,
        }).format(d),
      );
    }
    case "week": {
      const start = parseYmd(key);
      if (!start) return key;
      const end = addDays(start, 6);
      const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
      const yearForRange =
        end.getUTCFullYear() !== now.getUTCFullYear() ? "numeric" : undefined;
      const fmtShort = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
      });
      const fmtLong = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "short",
        year: yearForRange,
      });
      const s = fmtShort.format(start);
      const e = fmtLong.format(end);
      // E.g. "5 – 11 mai 2026" / "May 5 – 11, 2026"
      return sameYear ? `${s} – ${e}` : `${s} – ${e}`;
    }
    case "month": {
      const [y, m] = key.split("-").map((x) => parseInt(x, 10));
      if (!y || !m) return key;
      const d = new Date(Date.UTC(y, m - 1, 1));
      return cap(
        new Intl.DateTimeFormat(locale, {
          month: "long",
          year: "numeric",
        }).format(d),
      );
    }
    case "year":
      return key;
  }
}

/* ─────────── Internal helpers ─────────── */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseYmd(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Monday of the ISO week containing `d` (UTC). */
function startOfIsoWeek(d: Date): Date {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = r.getUTCDay() || 7; // Sun=0 → 7
  r.setUTCDate(r.getUTCDate() - (day - 1));
  return r;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
