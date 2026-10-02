import { cache } from "react";
import { requireSession } from "./viewer";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

export type AdminViewer = {
  email:        string;
  user_id:      string | null;
  accessToken:  string;
};

export type AdminResolution =
  | { kind: "ok";       viewer: AdminViewer }
  | { kind: "forbidden"; email: string | null }       // authed but not in ADMIN_EMAILS
  | { kind: "error";     message: string };          // backend unreachable / unexpected

/**
 * Server-side admin gate for /admin/* routes.
 *
 * Returns a discriminated result so the caller can render an inline
 * 403 / 500 page instead of redirecting silently. The previous version
 * redirected to /watch on failure, which created an infinite loop for
 * any authed user whose /watch path was ALSO broken (e.g. a fresh
 * account with no public.users row → /me 404 → / → /watch → loop).
 *
 * Authoritative check happens server-side via `GET /admin/me`, which
 * verifies the JWT AND the email vs the backend's `ADMIN_EMAILS` env.
 * No information about ADMIN_EMAILS is ever shipped to the browser.
 *
 * Cached per request so layout + page can both call without paying
 * the round-trip twice.
 *
 * **Unauthenticated case** still redirects to /login (via
 * `requireSession`) — that's the only safe path: we can't render an
 * authed-user shell without a session, and /login is guaranteed to be
 * reachable.
 */
export const requireAdmin = cache(
  async (nextPath = "/admin"): Promise<AdminResolution> => {
    const session = await requireSession(nextPath);
    try {
      const res = await fetch(`${API_URL}/admin/me`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        // Try to read the email from the JWT payload so the rendered
        // "Forbidden" page can show who's signed in. Best-effort:
        // fall back to null if anything goes wrong.
        let email: string | null = null;
        try {
          const payload = session.access_token.split(".")[1];
          const decoded = JSON.parse(
            atob(payload.replace(/-/g, "+").replace(/_/g, "/"))
          ) as { email?: string };
          email = decoded.email ?? null;
        } catch { /* leave null */ }
        return { kind: "forbidden", email };
      }
      if (!res.ok) {
        return { kind: "error", message: `Backend returned ${res.status}` };
      }
      const data = (await res.json()) as { email: string; user_id: string | null };
      return {
        kind: "ok",
        viewer: {
          email:       data.email,
          user_id:     data.user_id,
          accessToken: session.access_token,
        },
      };
    } catch (e) {
      return {
        kind: "error",
        message: e instanceof Error ? e.message : "Backend unreachable",
      };
    }
  },
);
