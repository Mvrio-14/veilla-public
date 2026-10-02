import * as React from "react";
import { useTranslations } from "next-intl";

/**
 * What the platform does, between the figures and the two products.
 *
 * One statement, set large, across the full width. It carries two
 * movements: what Veilla collects, and what it does with it. The figures
 * above say how *much* is covered; this says what kind of material that
 * is, which no number can.
 *
 * ## The cycling word
 *
 * The only motion here is the source type, which turns over. It says
 * "the list does not stop here" in the space of one word, where a comma
 * list can only say it by getting longer.
 *
 * The hand-over is a window: the slot is one line tall and clipped, and
 * the words travel up through it, the outgoing one leaving as the
 * incoming one arrives. No fade at all — a word that dissolves looks
 * switched off, a word that slides behind an edge looks like one of a
 * set. The two always overlap, so the slot is never empty, which the
 * published guidance is blunt about: never make a reader wait for a word
 * to settle.
 *
 * Only the source type turns. What Veilla does with the material is an
 * enumeration, not a choice among alternatives, so all three verbs stay
 * on screen: a reader who arrives mid-turn would otherwise see the
 * sentence claim one of them and hide the other two.
 *
 * ## What is actually readable
 *
 * Only the first alternative in each slot is exposed to assistive
 * technology. They are stacked in one grid cell and therefore all
 * present in the text layer, so without that a screen reader would be
 * handed "articlespress releasesnewsletters" as a single word and a
 * crawler would index it. Hidden, what remains is a whole sentence.
 *
 * ## The slot does not shift the line
 *
 * Every alternative sits in the same grid cell, so the slot is always as
 * wide as its longest word and nothing after it moves. Swapping a short
 * word for a long one in normal flow would reflow the rest of the
 * sentence on every turn, which is what makes this trick look cheap when
 * it is done badly.
 */

/** Whether the source type turns over. Off leaves the first alternative
 *  in place, which is also what a reader with reduced motion gets. */
const ROTATING = true;

export function LandingCoreSection() {
  const t = useTranslations("landing.core");
  const list = (text: string) =>
    text
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  // The statement is set the same distance from the figures above it as
  // from the heading below it, because the three read as one movement and
  // an uneven gap made it look attached to the band. Each gap is a pair of
  // paddings and both halves have to move together: 128 + 80 above,
  // 144 + 64 below. Changing one side alone is what breaks it.
  return (
    <section className="px-12 pb-36 pt-20 max-[1180px]:px-10 max-[980px]:px-8 max-[980px]:pb-24 max-[980px]:pt-12 max-[720px]:px-5">
      {/* The same block reveal every other section on the page uses, so
          this one does not arrive fully formed while its neighbours
          settle. */}
      {/* Inside the page's container, not centred in one of its own: the
          statement's left edge is now the same as the figures above and
          the products below. Centred in a narrower box it lined up with
          nothing, which reads as neither centred nor ranged. */}
      <div className="mx-auto max-w-[1280px] text-center">
        <p data-reveal className="core-line">
          {/* Held on one line above the breakpoint. The sentence is the
              claim; broken across two lines the cycling word lands alone
              on the second, which makes it look like a caption rather
              than part of what is being said. */}
          <span className="core-lead">
            {t("lead")} <Slot options={list(t("sources"))} cycles={ROTATING} />
          </span>
          {/* The second movement drops to its own line and steps back. It
            is the consequence, not the claim: what Veilla collects is
            what the reader is being asked to believe, what it does with
            it follows from that. Same size for both would have them
            argue. */}
          <span className="core-aside">
            {/* The reader's own doing comes first, and it is the reason
                this line exists at all: the figures above say how much is
                covered, but nothing on the page said the reader chooses
                what is watched. Only then what happens to it, which is
                the part they do not have to do. A full stop between the
                two and none at the end, as everywhere else here.

                Each sentence takes its own line rather than being left to
                wrap where it lands: broken at the sentence, the pair reads
                as two steps; broken mid-clause it read as one long
                sentence that happened to need two lines. */}
            <span className="core-aside-line">{t("pick")}</span>{" "}
            {/* Explicit, because JSX drops the whitespace between two
                elements when a newline sits in it — the two sentences ran
                into each other the moment they shared a line. */}
            <span className="core-aside-line">
              {t("mid")} {t("verbs")}
            </span>
          </span>
        </p>
      </div>
    </section>
  );
}

function Slot({ options, cycles }: { options: string[]; cycles: boolean }) {
  // Two seconds a word. The guidance is that marketing copy wants the
  // longer end of the range — a reader has to notice the word, read it,
  // and believe the list continues, and a quick turn only achieves the
  // first — but with seven alternatives the longer end puts the full tour
  // past twenty seconds, which is longer than anyone stands there. Nobody
  // sees the tour; two or three words is the whole of it.
  const cycle = options.length * 2;
  const longest = options.reduce((a, b) => (b.length > a.length ? b : a));

  return (
    <span className="core-slot">
      <span className="core-slot-grid" data-cycles={cycles ? "" : undefined}>
        {options.map((option, i) => (
          <span
            // The position in the list, never the word itself. A CSS
            // animation starts when it is applied to an element, so a
            // remount restarts it: keyed on the word, a language switch
            // replaced five of the seven nodes and left two running on
            // the old timeline, which put two words in the slot at once.
            key={i}
            className="core-option"
            aria-hidden={i > 0 || undefined}
            style={
              {
                "--cycle": `${cycle}s`,
                "--turns": `core-turn-${options.length}`,
                // Shifted back by the length of the rise, so the first
                // alternative is already up at load instead of the slot
                // opening empty for half a second. 0.03 is the rise in the
                // keyframes; the two have to agree or the word loads low.
                "--turn": `${((cycle / options.length) * i - cycle * 0.03).toFixed(2)}s`,
              } as React.CSSProperties
            }
          >
            {option}
          </span>
        ))}

        {/* A copy of the longest alternative, unseen, holding the width
            open while the visible ones share one grid cell. */}
        <span className="core-sizer" aria-hidden>
          {longest}
        </span>
      </span>
    </span>
  );
}
