import { createClient } from "@/lib/supabase/server";
import { NoAccessClient } from "./no-access-client";

/**
 * Dedicated landing for authenticated users whose backend lookup failed.
 *
 * Two scenarios end up here:
 *  1. The Supabase session is valid but there's no matching public.users
 *     row (= account created in Supabase Auth without a profile backfill).
 *  2. The backend /me endpoint returned an unexpected 5xx.
 *
 * Why a dedicated route: redirecting to `/` on failure would loop, since
 * `/` redirects authenticated visitors to `/watch`, and `/watch` calls
 * `requireViewer` again. This page is a terminal: it doesn't redirect
 * anywhere, so the loop cannot start.
 *
 * The page reads the current email from the Supabase session (no backend
 * call) and offers two actions: sign out, or retry.
 */
export default async function NoAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const email = session?.user?.email ?? null;
  const reason = params.reason === "error" ? "error" : "no-profile";

  return <NoAccessClient email={email} reason={reason} />;
}
