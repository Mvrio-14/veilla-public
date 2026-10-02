"use client";

/**
 * Typed fetch helpers for the /admin/* endpoints.
 *
 * Same auth flow as the user-facing actions (Bearer token from the
 * Supabase session). Centralized here so the admin pages don't reach
 * into `webapp/lib/actions.ts` (which is user-app surface) and so we
 * can keep admin types separate from public ones.
 *
 * No optimistic updates, no caching, no fancy state — admin tooling
 * shows server truth on every load. The component re-fetches after
 * any mutation it triggers.
 */
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";


async function adminFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error("Not authenticated");
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${session.access_token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  return res;
}


// ── Types ────────────────────────────────────────────────────────────────
export interface AdminSource {
  id:              number;
  name:            string;
  domain:          string;
  country:         string | null;
  paywall_policy:  string | null;
  robots_skip:     boolean;
  added_at:        string | null;
  n_feeds_alive:   number;
  n_feeds_dead:    number;
}

export interface AdminFeed {
  id:                    number;
  slug:                  string;
  name:                  string;
  url:                   string;
  feed_type:             string | null;
  /** Feed CONTENT language (ISO 639-1 lowercase) — DB column historically
   *  named `country` but semantically holds a lang code. */
  country:               string | null;
  source_id:             number | null;
  source_name:           string | null;
  source_domain:         string | null;
  /** Publisher country from `sources.country` (ISO 3166-1 alpha-2 or a
   *  regional code from `taxonomy.REGIONAL_CODES`). */
  source_country:        string | null;
  status:                "active" | "degraded" | "dead";
  consecutive_failures:  number;
  last_success_at:       string | null;
  last_failure_at:       string | null;
  added_at:              string | null;
  /** Subscribed to automatically when an account signs up. */
  starter:               boolean;
}

export interface FieldCoverage {
  field:   string;
  present: number;
  total:   number;
}

export interface SampleEntry {
  title:     string;
  published: string | null;
  summary:   string | null;
  image_url: string | null;
  source:    string | null;
}

export interface ProbeResult {
  ok:                       boolean;
  message:                  string;
  url:                      string;
  final_url:                string | null;
  feed_title:               string | null;
  feed_lang:                string | null;
  suggested_source_name:    string | null;
  suggested_source_domain:  string | null;
  n_entries:                number;
  detected_type:            string | null;
  field_coverage:           FieldCoverage[];
  unmapped_fields:          { name: string; count: number }[];
  sample_entries:           SampleEntry[];
}


// ── Sources ─────────────────────────────────────────────────────────────
export async function listSources(opts: { include_dead?: boolean } = {}): Promise<AdminSource[]> {
  const qs = opts.include_dead ? "?include_dead=true" : "";
  const res = await adminFetch(`/admin/sources${qs}`);
  if (!res.ok) throw res;
  const data = (await res.json()) as { sources: AdminSource[] };
  return data.sources;
}


// ── Feeds ───────────────────────────────────────────────────────────────
export async function listFeeds(opts: {
  source_id?:    number;
  include_dead?: boolean;
} = {}): Promise<AdminFeed[]> {
  const params = new URLSearchParams();
  if (typeof opts.source_id === "number") params.set("source_id",    String(opts.source_id));
  if (opts.include_dead)                  params.set("include_dead", "true");
  const qs = params.toString();
  const res = await adminFetch(`/admin/feeds${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw res;
  const data = (await res.json()) as { feeds: AdminFeed[] };
  return data.feeds;
}

export async function probeFeed(url: string): Promise<ProbeResult> {
  const res = await adminFetch(`/admin/feeds/probe`, {
    method: "POST",
    body:   JSON.stringify({ url }),
  });
  if (!res.ok) throw res;
  return (await res.json()) as ProbeResult;
}

export interface CreateFeedBody {
  url:           string;
  name:          string;
  slug?:         string | null;
  feed_type?:    string | null;
  /** Feed CONTENT language (ISO 639-1 lowercase: fr, en). The DB column
   *  is historically called `country` but semantically holds a lang. */
  country?:      string | null;
  source_id?:    number | null;
  source_name?:  string | null;
  /** Only consulted when seeding a new source. */
  source_domain?:         string | null;
  source_country?:        string | null;   // ISO 3166-1 alpha-2 uppercase
  source_paywall_policy?: string | null;   // "free" | "paywall" | "mixed" | null
  source_robots_skip?:    boolean;
}

export async function createFeed(body: CreateFeedBody): Promise<AdminFeed> {
  const res = await adminFetch(`/admin/feeds`, {
    method: "POST",
    body:   JSON.stringify(body),
  });
  if (!res.ok) {
    // surface the FastAPI detail string when present so the UI can show
    // "Slug already exists" inline.
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string }).detail ?? ""; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminFeed;
}

export async function updateFeed(
  feedId: number,
  patch: Partial<Pick<AdminFeed, "slug" | "name" | "url" | "feed_type" | "country" | "source_id" | "starter">>,
): Promise<AdminFeed> {
  const res = await adminFetch(`/admin/feeds/${feedId}`, {
    method: "PUT",
    body:   JSON.stringify(patch),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string }).detail ?? ""; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminFeed;
}

export async function setFeedStatus(
  feedId: number,
  status: "active" | "degraded" | "dead",
): Promise<AdminFeed> {
  const res = await adminFetch(`/admin/feeds/${feedId}/status`, {
    method: "PATCH",
    body:   JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AdminFeed;
}


// ── Users ──────────────────────────────────────────────────────────────
/** What a user may do: `demo` reads, `pro` can also save, file and create. */
export type UserPlan = "demo" | "pro";

export interface AdminUser {
  id:          string;
  slug:        string;
  name:        string;
  email:       string;
  output_lang: string;
  active:      boolean;
  is_public:   boolean;
  created_at?: string | null;
  updated_at?: string | null;
  plan:        UserPlan;
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await adminFetch(`/admin/users`);
  if (!res.ok) throw res;
  return ((await res.json()) as { users: AdminUser[] }).users;
}

export async function getUser(userId: string): Promise<AdminUser> {
  const res = await adminFetch(`/admin/users/${userId}`);
  if (!res.ok) throw res;
  return (await res.json()) as AdminUser;
}

export async function createUser(payload: {
  slug:         string;
  email:        string;
  name?:        string | null;
  output_lang?: string;
  active?:      boolean;
  is_public?:   boolean;
  plan?:        UserPlan;
}): Promise<AdminUser> {
  const res = await adminFetch(`/admin/users`, {
    method: "POST",
    body:   JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string }).detail ?? ""; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminUser;
}

export async function updateUser(
  userId: string,
  patch: {
    name?:        string  | null;
    slug?:        string  | null;
    email?:       string  | null;
    output_lang?: string  | null;
    active?:      boolean;
    is_public?:   boolean;
    plan?:        UserPlan;
  },
): Promise<AdminUser> {
  const res = await adminFetch(`/admin/users/${userId}`, {
    method: "PUT",
    body:   JSON.stringify(patch),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { detail?: string }).detail ?? ""; } catch {}
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return (await res.json()) as AdminUser;
}

// ── Audit log ──────────────────────────────────────────────────────────
export interface AdminAuditRow {
  id:             number;
  actor_user_id:  string | null;
  actor_slug:     string | null;
  actor_name:     string | null;
  actor_email:    string | null;
  action:         string;
  target_type:    string;
  target_id:      string | null;
  payload:        Record<string, unknown>;
  created_at:     string | null;
}

export interface AuditPayload {
  actions:         AdminAuditRow[];
  next_before_id:  number | null;
  has_more:        boolean;
}

export async function listAudit(opts: {
  actor_user_id?: string;
  action?:        string;
  target_type?:   string;
  target_id?:     string;
  before_id?:     number;
  limit?:         number;
} = {}): Promise<AuditPayload> {
  const p = new URLSearchParams();
  if (opts.actor_user_id) p.set("actor_user_id", opts.actor_user_id);
  if (opts.action)        p.set("action",        opts.action);
  if (opts.target_type)   p.set("target_type",   opts.target_type);
  if (opts.target_id)     p.set("target_id",     opts.target_id);
  if (typeof opts.before_id === "number") p.set("before_id", String(opts.before_id));
  if (typeof opts.limit     === "number") p.set("limit",     String(opts.limit));
  const qs = p.toString();
  const res = await adminFetch(`/admin/audit${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw res;
  return (await res.json()) as AuditPayload;
}
