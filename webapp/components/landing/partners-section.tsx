"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

/**
 * The last thing said before the closing call: who Veilla is looking for.
 *
 * ## Why this section exists
 *
 * Every reference page fills this slot with proof — logos, testimonials,
 * ROI figures. All three are closed here: there are no customers yet. The
 * honest move is not to fake the slot or to leave it empty but to explain
 * the absence, which turns it from a hole into a position. A newsroom
 * that gets to shape the tool it will use every day is offered something
 * no established competitor can offer back.
 *
 * ## The tense matters more than the words
 *
 * This is an invitation, not a description. "Veilla is built with a few
 * newsrooms" would claim partners that do not exist yet and is the kind
 * of thing that falls apart on the first call. "We are looking for
 * newsrooms" is true today, and it is the stronger sentence anyway: an
 * open invitation lets the reader be the first, where a vague existing
 * arrangement puts them late.
 *
 * ## Words beside a picture, on the page's own ground
 *
 * A full-bleed photographic band was tried first and abandoned. Whatever
 * the picture, the section ended up fighting it: a pale one left no ink
 * that could be read on it — measured, white never cleared 1.86:1 and
 * mid grey collapsed to 1.00 — and a dark one turned the page's quietest
 * moment into its loudest. Beside the words instead of behind them, the
 * picture can be any picture, the type is simply ink on paper, and the
 * section keeps the register of everything above it.
 */

/**
 * The statement, one word per element, each lit as the reader reaches it.
 *
 * Measured off the reference: a word not yet read is not invisible, it is
 * *dimmed* — 26% ink, a 2px blur and 2px of drop — and it comes up to
 * full colour in place. Fading from nothing would make the line arrive in
 * pieces; dimming keeps the whole sentence on screen and only moves the
 * reader's attention along it, which is the point.
 *
 * Driven by a view timeline rather than by a scroll listener: the browser
 * ties each word's progress to the heading's own travel through the
 * viewport, off the main thread, for no JavaScript at all. The reference
 * does the same thing with a library.
 *
 * Each word carries a trailing space outside its box. The spans are
 * `inline-block` so they can be blurred and moved, and an inline-block
 * swallows the whitespace that would otherwise separate it from the next.
 */
function Words({ plain, accent }: { plain: string; accent: string }) {
  const words = [
    ...plain.split(/\s+/).filter(Boolean).map((w) => ({ w, accent: false })),
    ...accent.split(/\s+/).filter(Boolean).map((w) => ({ w, accent: true })),
  ];

  // The numbers are derived from where the LAST word finishes, because
  // that is the moment the sentence is whole and the only one a reader
  // notices. Ending at two thirds of the heading's pass left it finishing
  // as the section was already leaving; at 46% it is complete while the
  // section still fills the screen.
  //
  // Each word's window is 2.6 times its share, so neighbours overlap and
  // the line brightens as a wave rather than as a row of switches — and
  // that overlap is why the step has to be solved for rather than
  // divided: the last window starts well before the end.
  const from = 2;
  const end = 46;
  const overlap = 2.6;
  const step = (end - from) / (words.length - 1 + overlap);

  return (
    <>
      {words.map(({ w, accent: isAccent }, i) => (
        <React.Fragment key={i}>
          <span
            className={`partners-word${isAccent ? " partners-accent" : ""}`}
            style={
              {
                "--range": `cover ${(from + i * step).toFixed(1)}% cover ${(
                  from + i * step + step * overlap
                ).toFixed(1)}%`,
              } as React.CSSProperties
            }
          >
            {w}
          </span>{" "}
        </React.Fragment>
      ))}
    </>
  );
}

/** The picture, cropped square. One place to change it. */
const IMAGE = "/landing/band/newsroom.webp";

export function LandingPartnersSection({
  onContactClick,
}: {
  onContactClick: () => void;
}) {
  const t = useTranslations("landing.partners");

  return (
    <section id="partners" className="px-12 pb-32 pt-28 max-[1180px]:px-10 max-[980px]:px-8 max-[980px]:pb-24 max-[980px]:pt-20 max-[720px]:px-5">
      {/* The picture first and the words answering it. Centred against
          each other rather than aligned at the top: the text block is
          shorter than the square, and hanging it from the top would leave
          it stranded against a tall edge. */}
      <div className="mx-auto grid max-w-[1280px] grid-cols-[minmax(0,560px)_1fr] items-center gap-x-24 max-[1180px]:gap-x-16 max-[980px]:grid-cols-1 max-[980px]:gap-y-12">
        {/* Square whatever the source is, and cropped from its centre to
            get there — the picture is taller than it is wide, so `cover`
            is doing real work rather than decorating.

            A background rather than an `<img>`: nothing here is content,
            it carries no information the words do not already carry, and
            an empty `alt` on a decorative photograph is the thing every
            screen reader would then have to skip.

            The radius is the tiles' 10px, so the page has one way of
            drawing a picture-shaped object. */}
        {/* No block reveal on the picture, and none on the heading either.
            The words light one by one as the reader reaches them; fading
            the pair in first would play a second, coarser animation over
            the top of that one and swallow it. Both are simply present,
            and only the reading moves. */}
        <div
          style={{ backgroundImage: `url('${IMAGE}')` } as React.CSSProperties}
          className="partners-photo aspect-square w-full rounded-[10px] bg-cover bg-center max-[980px]:max-w-[560px]"
        />

        <div>
          <h2 className="partners-line m-0 max-w-[17ch] text-balance">
            <Words plain={t("title")} accent={t("titleAccent")} />
          </h2>

          {/* The ask arrives just behind the statement, the same short
              delay the figures use between their cells. */}
          <div
            data-reveal
            style={{ "--reveal-delay": "0.1s" } as React.CSSProperties}
            className="mt-10 max-w-[46ch]"
          >
            <p className="m-0 text-[17px] leading-[1.55] text-text-2">
              {t("lead")}
            </p>

            {/* The same quiet link the two products use, not a filled
                button: the closing call comes straight after, and two
                solid buttons in a row split the decision in half. */}
            <button
              type="button"
              onClick={onContactClick}
              className="landing-quiet-cta mt-8 inline-flex cursor-pointer items-center gap-2 text-[15px] font-medium text-text no-underline"
            >
              {t("cta")}
              <span className="landing-product-arrow" aria-hidden>
                →
              </span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
