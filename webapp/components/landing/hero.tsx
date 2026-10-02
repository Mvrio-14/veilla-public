"use client";

import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { SIGN_IN_HREF, SIGN_UP_HREF } from "@/lib/routes";

/**
 * Hero — full-screen photograph that the rest of the page slides over.
 *
 * ## The motion
 *
 * The hero really scrolls — it is not pinned. `position: sticky` was the
 * first attempt and it was wrong: a pinned box does not move at all, so
 * the picture reads as frozen the moment the panel starts climbing, and
 * slowing its contents only made that worse.
 *
 * Instead the section is held back. It sits in normal flow, so scrolling
 * by S would carry it up by S; a transform gives back most of that,
 * leaving it climbing slowly. It never stops and it eventually leaves the
 * top of the window, exactly like anything else on the page — just much
 * more slowly.
 *
 * The panel below moves at full speed, so it closes on the hero and
 * covers it. That is the whole trick: nothing is stuck, the two planes
 * simply travel at different speeds, which is what depth looks like.
 *
 * ## Why this is not JavaScript
 *
 * It was, and it juddered. A scroll listener always runs a frame behind
 * the compositor: the browser paints the scroll first, then the callback
 * pushes the hero back, so the picture visibly jumps up and settles down
 * on every frame. No amount of rAF or throttling fixes that, because the
 * lag is structural.
 *
 * A scroll-driven CSS animation is evaluated by the compositor with the
 * scroll itself, so it cannot fall behind. Where it is unsupported the
 * hero simply scrolls at normal speed — no parallax, and no judder
 * either. The rule lives in `.landing-hero-hold`.
 *
 * ## Sizing
 *
 * `svh` rather than `vh`: on mobile `100vh` counts an address bar that
 * is not there, which pushes the buttons below the fold. The negative
 * top margin matches the sticky header's height so the photograph starts
 * at the top of the window.
 */

// Renaming on replacement is deliberate: the optimizer keys its cache on
// the URL, so swapping a file's bytes under the same name leaves every
// browser that already fetched it serving the old picture.
const HERO_IMAGE = "/landing/hero/newsroom-hero.webp";


export function LandingHero() {
  const t = useTranslations("landing.hero");
  return (
    <section className="landing-hero-hold relative z-0 -mt-16 h-[100svh] w-full overflow-hidden bg-[#0d1016] max-[720px]:-mt-14">
      <div className="absolute inset-0">
        <Image
          src={HERO_IMAGE}
          alt=""
          fill
          priority
          sizes="100vw"
          className="landing-hero-image object-cover"
        />

        <div className="landing-hero-scrim absolute inset-0" />
        <div className="landing-hero-topband absolute inset-x-0 top-0 h-28" />

        <div className="absolute inset-x-0 top-0 px-24 pt-[285px] max-[1180px]:px-14 max-[1180px]:pt-[240px] max-[980px]:px-8 max-[720px]:px-5 max-[720px]:pt-[185px]">
          <h1
            className="
              m-0 max-w-[17ch] font-accent text-[clamp(36px,4.9vw,62px)] font-normal
              leading-[1.07] tracking-[-0.022em] text-white
            "
          >
            {t("h1")}
          </h1>


          {/* One line under the headline, in the Legora shape: the title
              is the promise, this names the product and who it is for. */}
          <p className="mt-6 text-[19px] leading-[1.4] text-white/70 max-[720px]:text-[17px]">
            {t("sub")}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-2.5">
            <Link
              href={SIGN_UP_HREF}
              className="
                inline-flex h-11 items-center rounded-md bg-white px-6
                text-[14px] font-medium text-[#0d1016] no-underline
                transition-colors hover:bg-white/90 active:translate-y-px
              "
            >
              {t("ctaPrimary")}
            </Link>
            <Link
              href={SIGN_IN_HREF}
              className="
                inline-flex h-11 items-center rounded-md border border-white/35
                px-6 text-[14px] font-medium text-white no-underline
                transition-colors hover:border-white/70 active:translate-y-px
              "
            >
              {t("ctaGhost")}
            </Link>
          </div>

        </div>
      </div>
    </section>
  );
}
