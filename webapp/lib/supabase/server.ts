import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for use in Server Components, Server Actions, Route
 * Handlers, and the Proxy.
 *
 * The cookies adapter wires Supabase's session refresh into Next.js's cookie
 * store so the JWT and refresh token stay in sync across server-rendered
 * navigations.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components can't mutate cookies; the Proxy handles
            // refresh, so dropping these here is safe.
          }
        },
      },
    },
  );
}
