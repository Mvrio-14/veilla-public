/**
 * The monitors a reader follows: one row per monitor they subscribe to,
 * shaped as the API will return them.
 *
 * Health is derived from the monitor's `status`, which the worker writes
 * after every fetch. A reader cannot pause a shared monitor, only stop
 * following it, so there is no paused state here.
 */

export type MonitorTemplate = "rss" | "google_news";
export type MonitorStatus = "active" | "degraded" | "dead";
export type MonitorHealth = "ok" | "warn" | "error";

export type Monitor = {
  id: number;
  name: string;
  template: MonitorTemplate;
  /** The feed for RSS; the search URL for Google News. */
  url: string;
  /** The Google News search, as typed. Null for RSS. */
  query: string | null;
  /** The publisher's site, for its favicon. Null for Google News, whose
   *  publisher is resolved article by article. */
  site_url: string | null;
  /** Language of the content, ISO 639-1. */
  lang: string | null;
  country: string | null;
  status: MonitorStatus;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  /** The error of the last failed fetch, while the monitor is failing. */
  last_error: string | null;
  items_7d: number;
  last_item_at: string | null;
};

/** One fetch of a monitor — a `monitor_runs` row. */
export type MonitorRun = {
  id: number;
  started_at: string;
  duration_ms: number;
  outcome: "ok" | "not_modified" | "failed";
  items_seen: number;
  items_new: number;
  error: string | null;
};

/** An article a monitor delivered, for its detail page. */
export type MonitorItem = {
  id: number;
  title: string;
  url: string;
  published_at: string;
};

const HEALTH: Record<MonitorStatus, MonitorHealth> = {
  active: "ok",
  degraded: "warn",
  dead: "error",
};

export const healthOf = (monitor: Pick<Monitor, "status">): MonitorHealth =>
  HEALTH[monitor.status];

/** What needs attention first: a list sorted by name buries the one
 *  failing monitor among a hundred healthy ones. */
export const HEALTH_ORDER: Record<MonitorHealth, number> = { error: 0, warn: 1, ok: 2 };

export const HEALTH_STYLES: Record<MonitorHealth, string> = {
  ok: "bg-[color-mix(in_oklab,var(--good)_12%,transparent)] text-good",
  warn: "bg-priority-soft text-priority-text",
  error: "bg-hot-soft text-hot-text",
};
