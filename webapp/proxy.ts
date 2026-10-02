import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 Proxy (formerly Middleware) — runs before each navigation.
 *
 * Sole job: keep the Supabase session fresh by calling getUser() on every
 * request. If the access token has expired, Supabase auto-refreshes it
 * with the refresh token and rewrites the cookies. Without this, an
 * authenticated user would silently turn into "anonymous" after ~1h.
 *
 * Authorization itself happens in Server Components / Route Handlers,
 * not here — the (app) layout reads the session and the API enforces
 * is_public + ownership.
 */
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth token if needed and rewrites the cookies. The result
  // is intentionally unused — the side-effect on cookies is the point.
  await supabase.auth.getUser();

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
