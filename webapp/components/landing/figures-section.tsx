import * as React from "react";
import { useLocale, useTranslations } from "next-intl";

/**
 * The band of figures that sits between the hero and the products.
 *
 * It stands where the references put a wall of client logos. There is no
 * such wall yet, and the gap it leaves is not decorative — the reader
 * needs a beat of quiet after a full-screen photograph before being
 * asked to compare two products. Four numbers fill that beat and pay
 * their way, because they answer the first question a newsroom asks:
 * how much of the world does this actually watch.
 *
 * ## The numbers are derived, not typed
 *
 * `SOURCES` and `PER_SOURCE` are the only two figures anyone should
 * edit; the daily volume falls out of them. Writing it by hand would let
 * the two drift, and a claim that no longer follows from its own premise
 * is worse than no claim.
 *
 * ## The reveal
 *
 * Each column is `data-reveal`, a third of a second apart, over a
 * movement that lasts nearly a second. The gap has to be that wide: at a
 * tenth of a second the four numbers overlapped so heavily that they
 * read as one block fading in. Spaced like this the eye is handed them
 * one at a time, left to right, and the row takes about two seconds to
 * arrive — which is the point of showing them at all.
 */

/** Sources a newsroom can put under watch. Rounded down, hence the `+`. */
const SOURCES = 2000;

/** Items a source publishes on an average day. */
const PER_SOURCE = 20;

const COUNTRIES = 33;

/** Spanish, Arabic, Italian, Portuguese, English, German, Japanese,
 *  Chinese, Indonesian, Russian, Ukrainian — and the two the interface
 *  itself speaks. */
const LANGUAGES = 13;

export function LandingFiguresSection() {
  const t = useTranslations("landing.figures");
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale);

  // `id` is what React keys on, and it is deliberately not the label.
  // Keying on translated text makes the key change when the reader
  // switches language, which unmounts the cell and mounts a new one —
  // and a new node has no `data-shown`, so the reveal never fires on it
  // again and the figure stays invisible.
  const figures = [
    { id: "sources", value: `${number.format(SOURCES)}+`, label: t("sources") },
    { id: "countries", value: number.format(COUNTRIES), label: t("countries") },
    { id: "languages", value: number.format(LANGUAGES), label: t("languages") },
    { id: "published", value: number.format(SOURCES * PER_SOURCE), label: t("published") },
  ];

  // The band and the statement below it are one thought: how much is
  // covered, then what kind of material that is. So they sit close, and
  // the wide measured gap is spent further down, between the pair of
  // them and the products.
  return (
    <section className="px-12 pb-32 pt-24 max-[1180px]:px-10 max-[980px]:px-8 max-[980px]:pb-24 max-[980px]:pt-16 max-[720px]:px-5">
      <div className="mx-auto grid max-w-[1280px] grid-cols-4 max-[720px]:grid-cols-2 max-[720px]:gap-y-12">
        {figures.map((figure, i) => (
          <div
            key={figure.id}
            data-reveal
            style={{ "--reveal-delay": `${i * 0.32}s` } as React.CSSProperties}
            /* Ranged left, not centred. A centred number floats away from
               the rule beside it; set against the rule it reads as the
               head of a column, which is what it is.

               The hairlines are the same one that divides the two
               products further down, so the page has one way of
               separating things rather than two. Only the outer edges go
               without padding, so the row lines up with the headings
               above and below it. */
            className={[
              "px-10 max-[980px]:px-6 max-[720px]:px-4",
              i === 0
                ? "pl-0 max-[980px]:pl-0 max-[720px]:pl-0"
                : "border-l border-border",
              i === 3 ? "pr-0 max-[980px]:pr-0" : "",
              i === 2 ? "max-[720px]:border-l-0 max-[720px]:pl-0" : "",
              i === 1 ? "max-[720px]:pr-0" : "",
            ].join(" ")}
          >
            <p className="m-0 font-accent text-[clamp(36px,4.4vw,58px)] font-normal leading-none tracking-[-0.018em] text-text">
              {figure.value}
            </p>
            <p className="mt-5 text-[14px] leading-[1.4] text-text-2">
              {figure.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
