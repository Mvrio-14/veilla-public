"use client";

/**
 * Client-side API for the Boolean query mode.
 *
 * Wraps the three endpoints the Boolean editor depends on:
 *   POST /me/query/compile    — parse + return SQL preview + errors
 *   POST /me/query/test       — execute against the user's universe
 *                                and return count + sample articles
 *   GET  /me/entities/search  — typeahead autocomplete for @-mentions
 *
 * Auth is via the Supabase session token, same pattern as the rest of
 * `lib/actions.ts`. The fetchers throw on non-2xx so callers can
 * `try/catch` in component state. Compile + test endpoints return
 * structural success/failure (`ok: false`) when the parse fails — the
 * editor uses that to surface inline syntax errors.
 */
import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

export interface BooleanCompileResult {
  ok:           boolean;
  error:        string | null;
  sql_preview:  string | null;
  param_count:  number;
}

export interface BooleanTestSample {
  id:           number;
  title:        string;
  published_at: string | null;
  feed:         string | null;
  lang:         string | null;
}

export interface BooleanTestResult {
  ok:     boolean;
  error:  string | null;
  count:  number;
  sample: BooleanTestSample[];
}

export interface EntitySearchHit {
  entity_id:   number;
  qid:         string | null;
  name:        string;
  kind:        "person" | "org" | "location" | "event" | "market" | "product";
  country:     string | null;
  image_url:   string | null;
  description: string | null;
  n_articles:  number;
}

async function _authHeaders(): Promise<Record<string, string>> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session) headers.Authorization = `Bearer ${session.access_token}`;
  return headers;
}

export async function compileBooleanQuery(text: string): Promise<BooleanCompileResult> {
  const res = await fetch(`${API_URL}/me/query/compile`, {
    method:  "POST",
    headers: await _authHeaders(),
    body:    JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`compile failed: HTTP ${res.status}`);
  return res.json() as Promise<BooleanCompileResult>;
}

export async function testBooleanQuery(
  text: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<BooleanTestResult> {
  // The preview always runs at the retention cap server-side. The client
  // does NOT send a period_hours — the backend would ignore it. The label above the preview should
  // read "max window", not "last N days".
  const res = await fetch(`${API_URL}/me/query/test`, {
    method:  "POST",
    headers: await _authHeaders(),
    body:    JSON.stringify({
      text,
      limit: opts.limit ?? 10,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`test failed: HTTP ${res.status}`);
  return res.json() as Promise<BooleanTestResult>;
}

export async function searchEntities(
  q: string,
  opts: { kind?: EntitySearchHit["kind"]; limit?: number; signal?: AbortSignal } = {},
): Promise<EntitySearchHit[]> {
  if (!q.trim()) return [];
  const params = new URLSearchParams({ q: q.trim(), limit: String(opts.limit ?? 10) });
  if (opts.kind) params.set("kind", opts.kind);
  const res = await fetch(`${API_URL}/me/entities/search?${params.toString()}`, {
    method:  "GET",
    headers: await _authHeaders(),
    signal:  opts.signal,
  });
  if (!res.ok) throw new Error(`entity search failed: HTTP ${res.status}`);
  const data = (await res.json()) as { results: EntitySearchHit[] };
  return data.results;
}
