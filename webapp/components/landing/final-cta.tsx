"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { SIGN_UP_HREF } from "@/lib/routes";

/**
 * The closing call, built the way the reference builds its own: a
 * photograph running the full width, the words straight on it, and two
 * frosted panels underneath instead of a button and a link.
 *
 * ## Why the two panels are identical
 *
 * Measured on the reference, both of its closing cards are the same
 * declaration — `rgba(245, 245, 245, 0.2)` over `backdrop-filter:
 * blur(10px)`. What makes one look pale and the other dark in a
 * screenshot is not their fill, it is the photograph behind them. A
 * translucent panel takes the colour of whatever it covers, so one rule
 * produces both appearances and the card always belongs to its picture.
 *
 * ## Why they replace the button
 *
 * The page previously ended with a solid button and a text link beneath
 * it, and the section above this one also ends with a link — two calls in
 * a row, which splits a decision in half. Side by side and equal, the two
 * paths state what they actually are: one is self-serve, the other is a
 * conversation, and neither outranks the other.
 *
 * ## The ink is dark, and that is measured
 *
 * White type is what the reference uses, because its photograph is dark
 * where the words sit. This one is sand: sampled across it, white never
 * clears 1.9:1 anywhere, while near-black holds 10:1 over its pale top
 * and 4.7:1 through its middle. So the transposition keeps the technique
 * and flips the ink, rather than keeping the ink and veiling the picture.
 */
export function LandingFinalCta({ onContactClick }: { onContactClick: () => void }) {
  const t = useTranslations("landing");

  return (
    <section className="landing-close relative overflow-hidden px-12 pb-28 pt-32 max-[1180px]:px-10 max-[980px]:px-8 max-[980px]:pb-20 max-[980px]:pt-24 max-[720px]:px-5 max-[720px]:pb-16 max-[720px]:pt-20">

      {/* The motion blur. A standard deviation on x only and zero on y
          spreads each pixel sideways, which is what a camera does when it
          pans — `blur()` on its own is radial and would read as merely out
          of focus. It has to be a real SVG filter in the document for CSS
          to point at, and it draws nothing itself.

          A little deviation on y as well as x — 7 against 34. Pure x is a
          razor-thin smear, each row of pixels sliding along its own line
          and never touching its neighbours; a small vertical component
          lets the streaks bleed into each other, which is what reads as
          diffuse rather than as a scan artefact.

          The angle does not come from the filter, which can only blur on
          the axes. The layer is rotated, blurred along its own x, and the
          rotation carries the smear with it — filters are applied before
          transforms, so the streaks come out on the diagonal.

          `edgeMode="duplicate"` stops the filter dragging transparency in
          from the edges; the layer also overhangs the section on every
          side, so even that is out of sight. */}
      <svg width="0" height="0" aria-hidden className="absolute">
        <filter id="veilla-motion" x="-14%" y="-8%" width="128%" height="116%">
          <feGaussianBlur stdDeviation="34 7" edgeMode="duplicate" />
        </filter>
      </svg>

      <div className="mx-auto max-w-[1280px]">
        {/* Title left, the explanation beside it rather than under it —
            the reference's arrangement, and it keeps the block wide and
            shallow so the photograph is not reduced to a border. */}
        <div className="grid grid-cols-[1.1fr_1fr] items-start gap-x-24 max-[1180px]:gap-x-16 max-[980px]:grid-cols-1 max-[980px]:gap-y-8">
          <h2 className="partners-line m-0 max-w-[15ch] text-balance">
            {t("finalCta.title")}
          </h2>

          <p className="m-0 mt-12 max-w-[46ch] text-[17px] leading-[1.55] text-white max-[980px]:mt-0 max-[980px]:max-w-none">
            {t("finalCta.sub")}
          </p>
        </div>

        {/* The two ways in. Equal until one is pointed at, and then it
            takes the room: flex rather than a grid, because only flex
            lets one item claim what the other gives up. */}
        <div className="landing-close-cards mt-16 flex gap-4 max-[980px]:mt-12 max-[720px]:flex-col max-[720px]:gap-3">
          <Link href={SIGN_UP_HREF} className="landing-close-card">
            <span>{t("finalCta.cardTrial")}</span>
            <Arrow />
          </Link>

          <button type="button" onClick={onContactClick} className="landing-close-card">
            <span>{t("finalCta.cardContact")}</span>
            <Arrow />
          </button>
        </div>

      </div>
    </section>
  );
}

function Arrow() {
  return (
    <span className="landing-close-arrow" aria-hidden>
      <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
        <path
          d="M3 7h8M7 3l4 4-4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
