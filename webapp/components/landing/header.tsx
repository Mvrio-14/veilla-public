"use client";

import * as React from "react";
import { Fragment } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { EyeMark } from "@/components/eye-mark";
import { SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/routes";

/**
 * Landing top bar — full bleed, two states.
 *
 * At the top of the page it paints nothing at all: the photograph runs
 * under it uninterrupted and the bar is white type on the image. Once
 * the page has scrolled past the first few pixels it fills with a translucent
 * wash and a backdrop blur, which is what keeps it legible when the
 * sections below start passing underneath. Both states are in
 * `.landing-topbar` / `.landing-topbar--scrolled`.
 *
 * The call to action follows the same switch: an outline over the
 * photograph, where a filled button would be a white slab on a picture,
 * and solid once the bar has a surface to sit on and the action should
 * carry weight.
 *
 * ## What actually triggers the switch
 *
 * Not a distance scrolled — the arrival of the pale panel. The hero is
 * held back to a tenth of the scroll while the panel below climbs at
 * full speed, so the background behind the bar stays dark for most of a
 * viewport. Switching the type to dark on the first few pixels left it
 * dark-on-dark and unreadable the whole way down.
 *
 * So the bar watches the panel's top edge and flips when it reaches the
 * bar's own height. A scroll listener is fine for this, unlike for the
 * parallax: a class toggle landing one frame late is invisible, whereas
 * a transform landing one frame late judders.
 *
 * ## Sticky, and still over the image
 *
 * The bar stays put on scroll. Sticky means it takes its 64px in the
 * flow, so the hero pulls itself back up underneath with a matching
 * negative margin; that is what lets the photograph reach the top of
 * the window while the bar keeps sticking.
 */
export function LandingHeader() {
  const t = useTranslations("landing");
  const headerRef = React.useRef<HTMLElement>(null);
  /* Three states, not two. The bar is white over the hero photograph,
   * dark once the pale panel has climbed under it, and white again from
   * the closing section down — everything from there to the foot of the
   * page is a dark picture or black. */
  const [mode, setMode] = React.useState<"hero" | "panel" | "dark">("hero");

  React.useEffect(() => {
    const panel = document.getElementById("landing-panel");
    const header = headerRef.current;
    if (!panel || !header) return;

    let frame = 0;
    const check = () => {
      frame = 0;
      const reach = header.offsetHeight;
      // The dark run has no end to test: it starts at the closing section
      // and continues through the footer to the bottom of the document.
      const close = document.querySelector(".landing-close");
      if (close && close.getBoundingClientRect().top <= reach) {
        setMode("dark");
        return;
      }
      setMode(panel.getBoundingClientRect().top <= reach ? "panel" : "hero");
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };

    // Scheduled rather than called: setState during an effect is banned.
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <header
        ref={headerRef}
        className={`landing-topbar sticky top-0 z-50 ${
          mode === "hero" ? "" : "landing-topbar--scrolled"
        } ${mode === "dark" ? "landing-topbar--dark" : ""}`}
      >
        <div className="flex h-16 w-full items-center justify-between px-24 max-[1180px]:px-14 max-[980px]:px-8 max-[720px]:h-14 max-[720px]:px-5">
          <Link
            href="/"
            className="inline-flex items-center gap-2 no-underline"
          >
            <EyeMark size={29} decorative />
            <span className="font-wordmark pl-[3px] text-[18px] font-medium uppercase tracking-[0.23em]">
              Veilla
            </span>
          </Link>

          <div className="flex items-center gap-5 max-[720px]:gap-3">
            <LanguageToggle label={t("lang.toggle")} />
            <Link
              href={SIGN_IN_HREF}
              className="text-[13.5px] font-medium no-underline opacity-80 transition-opacity hover:opacity-100 max-[720px]:hidden"
            >
              {t("nav.signin")}
            </Link>
            <Link
              href={SIGN_UP_HREF}
              className="
                landing-topbar-cta inline-flex h-9 items-center rounded-md
                border border-current px-5 text-[13.5px] font-medium
                no-underline hover:opacity-80 active:translate-y-px
              "
            >
              {t("nav.trial")}
            </Link>
          </div>
        </div>
      </header>
    </>
  );
}

/**
 * EN / FR, in the top bar.
 *
 * The locale is a cookie and no part of the URL, so switching is a write
 * plus a refresh — not a navigation. `router.refresh()` re-renders the
 * server components against the new cookie, which swaps the message
 * catalogue without reloading the document, losing the scroll position
 * or re-fetching the hero photograph.
 *
 * Both locales are always on screen rather than hidden behind a menu.
 * With two of them a menu costs a click to discover what a glance would
 * have told you, and the pair is four characters wide.
 *
 * `aria-pressed` carries the state rather than a class, so the same
 * attribute drives the styling and tells a screen reader which one is
 * active.
 */
/* Writing the cookie lives out here on purpose. Inside the component the
 * compiler's immutability rule reads `document.cookie = …` as mutating
 * something declared outside it, and is right to be suspicious — it just
 * cannot tell an event handler from render. */
function rememberLocale(code: string) {
  // A year, so a reader who comes back is not asked again. `Lax` keeps it
  // off cross-site requests, which is all this needs.
  document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=31536000; SameSite=Lax`;
}

function LanguageToggle({ label }: { label: string }) {
  const locale = useLocale();
  const router = useRouter();

  const pick = (next: string) => {
    if (next === locale) return;
    rememberLocale(next);
    router.refresh();
  };

  return (
    <div className="landing-lang" role="group" aria-label={label}>
      {(["en", "fr"] as const).map((code, i) => (
        <Fragment key={code}>
          {i > 0 && (
            <span className="landing-lang-sep" aria-hidden>
              /
            </span>
          )}
          <button
            type="button"
            onClick={() => pick(code)}
            aria-pressed={code === locale}
            className="landing-lang-btn"
          >
            {code.toUpperCase()}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
