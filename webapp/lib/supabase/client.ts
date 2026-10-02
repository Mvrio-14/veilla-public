import { createBrowserClient } from "@supabase/ssr";

// Wrapped in a helper so `ReturnType<typeof makeClient>` resolves to the
// concrete inferred SupabaseClient type (the same one the previous
// non-memoised export produced). Typing the cache via
// `ReturnType<typeof createBrowserClient>` directly loses the generic
// inference and turns every `.on(payload)` / session callback into
// `any`.
function makeClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}

let _client: ReturnType<typeof makeClient> | null = null;

/**
 * Supabase client for use in Client Components.
 *
 * Memoised singleton — every browser-side caller shares the SAME instance.
 * This is the pattern @supabase/ssr explicitly recommends, and it matters:
 * with a fresh instance per call (15+ call sites: notif-bell, the realtime
 * hooks, actions, user-menu, …), each one races to acquire the auth Web
 * Lock `lock:sb-<ref>-auth-token` on mount. The Supabase SDK steals the
 * lock to win disputes, so the losing promises reject with
 * `AbortError: Lock broken by another request with the 'steal' option`
 * and `Error: Lock "..." was released because another request stole it`.
 * Functionally harmless (auth still works) but pollutes Sentry.
 *
 * Reads the session from the same cookies that the server-side client writes,
 * so signing in on the browser propagates to subsequent server renders.
 */
export function createClient() {
  if (!_client) _client = makeClient();
  return _client;
}
