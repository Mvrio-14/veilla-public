"use client";

import { Suspense, useState } from "react";
import { MailCheck } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { EyeMark } from "@/components/eye-mark";
import { cn } from "@/lib/utils";

/**
 * Sign in — and sign up, which are the same action here.
 *
 * `signInWithOtp` emails a link. If the address is unknown, Supabase creates
 * the identity; if it is known, it signs the person in. One field, one
 * button, and no separate registration screen to build or explain.
 *
 * That removes, rather than hides, a whole family of surface area: no
 * password to store, no strength rules, no reset flow, and no "confirm your
 * address" step distinct from the link itself. The email IS the
 * confirmation.
 *
 * The public.users row is not created here. It is provisioned by the API on
 * the first authenticated request (`resolve_user_id` in src/auth.py), which
 * is also where the account is subscribed to the starter feeds. Keeping it
 * there means it works whatever the sign-in method, and only one code path
 * can ever create a user.
 *
 * ## One screen that names both intents
 *
 * Someone who clicked "Try it for free" and someone who clicked "Sign in"
 * perform the identical action here, so the heading names both rather than
 * guessing which of the two is reading it. A screen that says only "Sign in"
 * makes a new visitor wonder which account they are supposed to have; one
 * that says only "Create an account" makes a returning one wonder whether
 * theirs is gone. Naming the pair costs a few words and excludes nobody.
 *
 * `SIGN_UP_HREF` carries `?intent=signup`, but the parameter changes
 * nothing on this page, so a shared or edited link cannot show the wrong
 * words.
 */

const DEFAULT_NEXT = "/watch";

/** Same-site paths only. `next` comes from the query string, so it is
 *  attacker-controlled: `//host` and `/\host` are read by browsers as
 *  protocol-relative URLs and would leave the site. */
function isInternalPath(value: string | null): value is string {
  if (!value || !value.startsWith("/")) return false;
  return !value.startsWith("//") && !value.startsWith("/\\");
}

function LoginForm() {
  const t = useTranslations("auth");
  const searchParams = useSearchParams();

  const rawNext = searchParams.get("next");
  const next = isInternalPath(rawNext) ? rawNext : DEFAULT_NEXT;
  const linkError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [errorMessage, setErrorMessage] = useState("");

  async function sendLink() {
    if (!email) return;

    setStatus("sending");
    setErrorMessage("");

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // Where Supabase sends the browser once it has validated the token.
        // This exact origin must be in the project's redirect allow-list, or
        // Supabase silently falls back to the configured Site URL.
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        // Signup is open: an unknown address creates an account. Setting this
        // to false is how registration closes again, without touching
        // anything else.
        shouldCreateUser: true,
      },
    });

    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }

    setStatus("sent");
  }

  // The two failure sources are mutually exclusive — a submit that just failed,
  // or a dead link the callback bounced back here. One slot renders whichever
  // is live, so the layout reserves its height once.
  const errorText =
    status === "error"
      ? errorMessage || t("genericError")
      : linkError && status === "idle"
        ? t("linkInvalid")
        : null;

  const submitDisabled = status === "sending" || !email;

  return (
    <main className="min-h-screen flex flex-col bg-bg text-text">
      {/* Nothing in the corners. A sign-in screen is a dead end by design:
       *  the only way forward is the one field, and the way back is the
       *  browser's own back button, which is where people look for it. A
       *  bespoke arrow only competes with it. */}

      {/* `min-h-screen`, not `dvh`: the field below autofocuses, and a mobile
       *  keyboard shrinking `dvh` would yank a centred column upward on load. */}
      <div className="flex-1 flex items-center justify-center px-5 py-16 max-[480px]:py-14">
        <div className="w-full max-w-[400px]">
          <div className="flex items-center justify-center gap-2 text-text">
            <EyeMark size={28} decorative />
            {/* `pl-[2px]` cancels the trailing letter-space that the wide
             *  tracking leaves after the final A, which would otherwise sit
             *  the lockup a hair left of true centre. */}
            <span className="font-wordmark text-[16px] font-medium tracking-[0.24em] uppercase pl-[2px]">
              Veilla
            </span>
          </div>

          <h1 className="mt-9 text-center font-display text-[28px] max-[480px]:text-[24px] font-medium tracking-[-0.005em] leading-[1.15] text-balance text-text">
            {t("heading")}
          </h1>

          <p className="mt-3 text-center text-[13px] leading-[1.55] text-pretty text-text-3">
            {t("magicLinkPrompt")}
          </p>

          {/* One height for both states. The confirmation is the taller of the
           *  two, so without this the whole centred column jumps when the form
           *  is swapped out. 168px is the measured worst case: the French
           *  `linkSentBody`, which interpolates the address, wrapping to three
           *  lines for a ~45-character one. The idle form measures 140px. */}
          <div className="mt-9 min-h-[168px]">
            {status === "sent" ? (
              <div
                role="status"
                className="flex flex-col items-center text-center"
              >
                <MailCheck size={20} className="text-text-3" aria-hidden />
                <p className="mt-4 text-[14px] font-semibold text-text">
                  {t("linkSentTitle")}
                </p>
                <p className="mt-2 text-[13px] leading-[1.55] text-text-3">
                  {t("linkSentBody", { email })}
                </p>
                <button
                  type="button"
                  onClick={() => setStatus("idle")}
                  className="mt-6 text-[12.5px] text-text-3 underline underline-offset-2 decoration-text-4 hover:text-text hover:decoration-text cursor-pointer transition-colors"
                >
                  {t("useAnotherEmail")}
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendLink();
                }}
                className="flex flex-col gap-2.5"
              >
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="email"
                    className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-text-3"
                  >
                    {t("emailLabel")}
                  </label>
                  {/* 16px below 640px is not a style choice: iOS Safari zooms
                   *  into any focused field under 16px, and this one
                   *  autofocuses. */}
                  <input
                    id="email"
                    type="email"
                    required
                    autoFocus
                    autoComplete="email"
                    placeholder={t("emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={status === "sending"}
                    className="
                      w-full h-10 rounded-md
                      bg-bg-elev border border-border
                      px-3.5 text-[13px] max-[640px]:text-[16px] text-text
                      placeholder:text-text-4
                      focus:outline-none focus:border-text-3
                      disabled:opacity-60
                    "
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitDisabled}
                  className={cn(
                    "w-full h-10 rounded-md text-[13px] font-semibold transition-colors",
                    submitDisabled
                      ? "bg-bg-sub text-text-4 cursor-not-allowed"
                      : "bg-text text-bg hover:bg-text-2 cursor-pointer",
                  )}
                >
                  {status === "sending" ? t("sendingLink") : t("sendLink")}
                </button>

                {/* Always mounted, so an error neither shifts the column nor
                 *  goes unannounced — a node created after the change is
                 *  routinely missed by assistive tech. */}
                <p
                  aria-live="polite"
                  className="min-h-[17px] text-center text-[12px] leading-[1.4] text-hot-text"
                >
                  {errorText}
                </p>
              </form>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
