import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Magic-link landing point.
 *
 * Supabase sends the user an email containing a link to its own `/auth/v1/
 * verify` endpoint, which validates the token and then redirects here with a
 * one-time `code`. Exchanging that code for a session is what actually signs
 * the person in, and it has to happen server-side so the session cookies are
 * set on a response the browser will keep.
 *
 * This route is the reason magic links need any code at all. Everything else
 * — sending the email, expiring the token, rate limiting — is Supabase's.
 *
 * ## Why `next` is validated
 *
 * The destination travels in the URL so a link can bring someone back to the
 * page they were trying to reach. That makes it attacker-controlled: a
 * crafted link with `next=//evil.example` would turn our own domain into a
 * redirector, which is exactly the sort of thing phishing filters flag and
 * users trust. Only same-site paths are accepted.
 *
 * ## Why the locale cookie is set here
 *
 * The previous password form fetched `/me` after signing in to align the
 * interface language with the user's content language. Sign-in now completes
 * on the server, so that step moves here — otherwise someone reading English
 * articles would land on a French interface.
 */

const DEFAULT_NEXT = "/watch";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://api.veilla.io";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** A same-site path: starts with one slash, and only one.
 *
 *  `//host` and `/\host` are both read as protocol-relative URLs by browsers
 *  and would leave the site. */
function isInternalPath(value: string | null): value is string {
  if (!value || !value.startsWith("/")) return false;
  return !value.startsWith("//") && !value.startsWith("/\\");
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const rawNext = searchParams.get("next");
  const next = isInternalPath(rawNext) ? rawNext : DEFAULT_NEXT;

  // Supabase reports expired or already-used links this way rather than by
  // omitting the code, and the distinction matters to the person reading the
  // screen: "your link has expired" is actionable, "something went wrong" is
  // not.
  const error = searchParams.get("error_description") ?? searchParams.get("error");
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error)}`,
    );
  }

  const code = searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error: exchangeError } =
    await supabase.auth.exchangeCodeForSession(code);

  if (exchangeError || !data.session) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(
        exchangeError?.message ?? "exchange_failed",
      )}`,
    );
  }

  const response = NextResponse.redirect(`${origin}${next}`);

  // Best effort: a failure here costs the user a language preference, not
  // their session. It must never turn a successful sign-in into an error.
  try {
    const me = await fetch(`${API_URL}/me`, {
      headers: { Authorization: `Bearer ${data.session.access_token}` },
      cache: "no-store",
    });
    if (me.ok) {
      const { output_lang } = (await me.json()) as { output_lang?: string };
      if (output_lang === "en" || output_lang === "fr") {
        response.cookies.set("NEXT_LOCALE", output_lang, {
          path: "/",
          maxAge: ONE_YEAR,
          sameSite: "lax",
        });
      }
    }
  } catch {
    /* non-fatal */
  }

  return response;
}
