import { cache } from "react";
import { redirect } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";

export type Viewer = {
  slug: string;
  accessToken: string;
  /** Whether this account may create things — saved stories, follows,
   *  views, folders. Comes straight from `/me`, which computes it with the
   *  same functions the API's write middleware uses, so the interface can
   *  never disagree with what the backend will actually allow.
   *
   *  It is the decision, not the plan behind it: adding a third tier, or
   *  an admin override, changes nothing on this side. */
  canWrite: boolean;
};

/**
 * Cheap auth gate — reads the Supabase session from cookies (no network)
 * and redirects to /login if no session. Use this in the (app) layout so
 * the topbar can render INSTANTLY without waiting on the backend.
 *
 * Pages that need slug / access token should call `requireViewer()`
 * instead, ideally inside a `<Suspense>` so the layout doesn't block.
 */
export async function requireSession(nextPath?: string): Promise<Session> {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    redirect(
      nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login",
    );
  }
  return session;
}

/**
 * Full viewer resolution (Supabase session → public.users row).
 *
 * Calls the backend `/me` endpoint to map the JWT to the user's slug.
 * Cached per request via React.cache so multiple callers on the same
 * render share the round-trip.
 *
 * Behavior:
 *   - No session   → redirect to /login (with `next` if provided).
 *   - Session OK   → call backend /me to resolve the slug.
 *   - /me 4xx      → redirect to /no-access?reason=no-profile (the
 *                    Supabase account exists but there's no public.users
 *                    row — terminal page, no further redirects, breaks
 *                    the infinite loop we had via "/" → /watch → /me 404).
 *   - /me 5xx /
 *     fetch throws → redirect to /no-access?reason=error (backend down).
 */
export const requireViewer = cache(
  async (nextPath?: string): Promise<Viewer> => {
    const session = await requireSession(nextPath);

    let res: Response;
    try {
      res = await fetch(`${API_URL}/me`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store",
      });
    } catch {
      redirect("/no-access?reason=error");
    }

    if (!res.ok) {
      const reason = res.status >= 500 ? "error" : "no-profile";
      redirect(`/no-access?reason=${reason}`);
    }

    const { slug, can_write } = (await res.json()) as {
      slug: string;
      can_write?: boolean;
    };
    // Absent field → treat as read-only. An older API that does not send
    // the flag yet would otherwise present every control as available and
    // have the backend refuse each one; the same fail-closed default the
    // middleware applies.
    return { slug, accessToken: session.access_token, canWrite: can_write === true };
  },
);
