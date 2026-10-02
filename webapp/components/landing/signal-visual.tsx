"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { EyeMark } from "@/components/eye-mark";

/**
 * The Veilla Signal visual — the agent working, in three beats: signals
 * arrive and pile up beneath it, it weighs the pile, one result is
 * written and delivered.
 *
 * ## Selecting Signal plays it, a sideways swipe steers it
 *
 * `data-phase` on the track goes 0, 1, 2 on a timer, started when the
 * reader selects the Signal column. Two earlier drivers were wrong for
 * the same reason: scrubbing the sequence off the scroll meant nothing
 * moved unless the reader kept moving, and advancing it by scroll
 * position meant it played out while the tile was still hidden behind
 * the other product — Desk holds the selection at rest, so Signal's
 * visual is at zero opacity until someone points at it.
 *
 * Every animation is declared once and starts **paused**. A beat's
 * animations are unpaused when their beat arrives and are never paused
 * again, so a finished beat holds its end frame while the next one runs
 * on top of it. That is what keeps the agent, the pile and the two
 * survivors continuous across beats instead of cross-fading three
 * separate drawings: they are the same elements throughout, and nothing
 * is ever reset mid-sequence.
 *
 * `data-p` on an element says which beat owns its animation; the gating
 * rules live in `globals.css`. Two elements are animated in more than
 * one beat and take a comma list instead, because `animation-play-state`
 * applies per animation, not per element.
 *
 * ## One object, not three pictures
 *
 * The agent and the pile are declared once, outside any beat. An agent
 * redrawn per beat can only ever be swapped, and the eye reads a swap as
 * a cut. Declared once, it travels — from the middle of the frame where
 * the signals converge on it, to the corner where it presides over the
 * list it has gathered.
 *
 * The notification is not a separate object either. The two signals the
 * agent keeps *are* the notifications: they brighten where they stand,
 * shrink to links, and dock under the message written from them.
 * Building a fresh element for the last beat would have thrown away the
 * one thing the sequence is trying to say, which is that what arrives
 * and what is delivered are the same material.
 *
 * ## Deliberately wordless
 *
 * The cards carry an icon and two bars, never a headline. Naming real
 * outlets in a marketing visual claims a relationship with them, and
 * inventing plausible ones fabricates news; bars make the same point and
 * never go stale. The icons say where a signal came from — a feed, a
 * social account, an API — which is the one fact about it that is worth
 * stating and cannot go out of date.
 *
 * The whole thing is `aria-hidden`: a sequence that replays on every
 * pass is noise to a screen reader, and the tile's heading and body
 * already say what the product does.
 */

type Source = "rss" | "social" | "api";

/**
 * Where each signal pops in, measured from the slot it will land in.
 * The offsets are irregular on purpose — laid out evenly this stops
 * reading as information arriving and starts reading as a menu
 * unfolding. Several start outside the tile, which is clipped:
 * information comes from beyond the frame, so it should enter from
 * beyond the frame.
 *
 * The last three have no offset. They were always in the pile and are
 * only revealed under the others, so they arrive from nowhere.
 */
const SIGNALS: {
  from: Source;
  x: number;
  y: number;
  bar: number;
  /** Non-null for the two the agent keeps, and their order in the pair. */
  rank?: 0 | 1;
}[] = [
  { from: "rss", x: -290, y: -112, bar: 168 },
  { from: "social", x: 268, y: -146, bar: 132, rank: 0 },
  { from: "api", x: -232, y: 138, bar: 196 },
  { from: "rss", x: 322, y: 96, bar: 146 },
  { from: "api", x: 0, y: -10, bar: 178, rank: 1 },
  { from: "social", x: 0, y: -10, bar: 124 },
  { from: "rss", x: 0, y: -10, bar: 190 },
];

/** Seconds. A card that pops in from outside travels further and takes
 *  longer than one that is merely uncovered. */
function cardTiming(i: number) {
  // Rounded, because these go straight into the DOM as inline custom
  // properties and floating-point arithmetic leaves a tail there.
  const round = (n: number) => Math.round(n * 100) / 100;
  return i < 4
    ? { delay: round(i * 0.65), dur: 1.43 }
    : { delay: round(3.12 + (i - 4) * 0.39), dur: 0.91 };
}

/**
 * How long each beat holds, animation plus the pause after it. These are
 * the durations the progress bars run on, and the bars are what advance
 * the sequence — so this is the only place the pacing is written.
 */
const BEATS = [6, 6, 6];

/**
 * Which beat each animation belongs to.
 *
 * It has to stay in step with the gate in `globals.css`; it exists
 * because the attribute alone only toggles pause states and says nothing
 * about where an animation stands. Leaving a beat early has to *settle*
 * it — jump it to its end — and returning to one has to rewind it,
 * neither of which a class change can express.
 *
 * The ambient loops and the progress fill are deliberately absent. The
 * loops are infinite, and `finish()` on an infinite animation throws;
 * the fill is the clock, and must never be wound by what it drives.
 */
const BEAT_OF = new Map<string, number>([
  ["signal-card-in", 0],
  ["signal-agent-move", 1],
  ["signal-pile-move", 1],
  ["signal-sweep", 1],
  ["signal-card-out", 1],
  ["signal-card-box-up", 1],
  ["signal-card-home", 2],
  ["signal-card-chip", 2],
  ["signal-vanish", 2],
  ["signal-appear", 2],
  ["signal-agent-out", 2],
  ["signal-message-in", 2],
  ["signal-message-settle", 2],
  ["signal-message-land", 2],
  ["signal-ping", 2],
  ["signal-write", 2],
  ["signal-caret-life", 2],
  ["signal-message-sent", 2],
]);

function vars(extra: Record<string, string | number>) {
  return extra as React.CSSProperties;
}

export function SignalAgentVisual() {
  const t = useTranslations("landing.platform.signal.steps");
  const labels = [t("ingest"), t("reason"), t("act")];
  const stageRef = React.useRef<HTMLDivElement>(null);
  const railRef = React.useRef<HTMLDivElement>(null);

  /**
   * The rail is the single source of truth. A sideways swipe scrolls it,
   * the auto-advance scrolls it, and its position is read back as the
   * beat — so the gesture and the clock can never disagree about where
   * the sequence stands.
   *
   * Sideways rather than down because of one CSS property:
   * `scroll-snap-stop: always` makes the browser halt at every snap
   * point even during a fling, which is the "never skip a step"
   * guarantee. Three attempts at reproducing that on the vertical wheel
   * failed, because nothing in the platform separates a push of the
   * finger from the momentum that follows it.
   *
   * The clock is the progress bar itself. Its fill is a CSS animation of
   * the beat's length and its `animationend` is what advances the
   * sequence: one source of truth, no drift, and pausing the bar pauses
   * the advance with it.
   */
  React.useEffect(() => {
    const stage = stageRef.current;
    const rail = railRef.current;
    const column = stage?.closest<HTMLElement>(".landing-product");
    if (!stage || !rail || !column) return;

    let beat = -1;
    let armed = false;
    let frame = 0;

    /**
     * Put every animation where the new beat needs it: those belonging
     * to earlier beats are finished, which with `forwards` leaves their
     * end frame standing, and everything from this beat onward is
     * rewound. A reader who swipes early never sees two beats overlap,
     * and one who swipes back never finds a later beat's end state lying
     * around.
     *
     * `subtree: true` is what reaches the pseudo-elements — the arrival
     * ring is a `::after` and has no other way of being addressed.
     */
    const settle = () => {
      for (const animation of stage.getAnimations({ subtree: true })) {
        const owner = BEAT_OF.get((animation as CSSAnimation).animationName);
        if (owner === undefined) continue;
        if (owner < beat) animation.finish();
        else animation.currentTime = 0;
      }
    };

    const show = (next: number) => {
      if (next === beat) return;
      beat = next;
      stage.dataset.phase = String(next);
      settle();
    };

    const read = () => {
      frame = 0;
      const slot = rail.clientWidth || 1;
      show(Math.min(2, Math.max(0, Math.round(rail.scrollLeft / slot))));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    rail.addEventListener("scroll", schedule, { passive: true });

    // Wrapping back to the first beat jumps rather than glides: a smooth
    // scroll across two snap points would be halted at the one between,
    // by the very property that makes a swipe reliable.
    const goTo = (next: number, jump = false) =>
      rail.scrollTo({
        left: next * rail.clientWidth,
        behavior: jump ? "auto" : "smooth",
      });

    // It runs to the end and stops there. Looping would take the
    // finished message away from anyone still reading it, and put the
    // tile back to moving indefinitely for no one's benefit. Starting
    // over costs a swipe, or leaving the column and coming back.
    const onFilled = (event: AnimationEvent) => {
      if (event.animationName !== "signal-fill" || beat >= 2) return;
      goTo(beat + 1);
    };
    stage.addEventListener("animationend", onFilled);

    const arm = () => {
      armed = true;
      beat = -1;
      stage.removeAttribute("data-phase");
      void stage.offsetWidth; // forces the restart to take
      goTo(0, true);
      show(0);
    };
    column.addEventListener("pointerenter", arm);

    // Stacked, there is no hover and no selection to make, so it starts
    // when the tile is actually on screen.
    const touch = window.matchMedia("(hover: none), (max-width: 980px)");
    const onScreen = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && touch.matches && !armed) arm();
      },
      { threshold: 0.4 },
    );
    onScreen.observe(column);

    return () => {
      rail.removeEventListener("scroll", schedule);
      stage.removeEventListener("animationend", onFilled);
      column.removeEventListener("pointerenter", arm);
      onScreen.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="signal-stage" ref={stageRef} aria-hidden>
      <div className="signal-caption">
        {/* Stories-style: the segments before the live one are full,
            the live one fills over its beat, the rest are empty. The
            fill is also the clock — see the effect above. */}
        <div className="signal-segs">
          {labels.map((label, i) => (
            <span
              // Index, not the label: "Reasoning" and "Raisonnement"
              // differ, so keying on the text remounted this segment on a
              // language switch — and it carries the fill whose
              // `animationend` advances the beat.
              key={i}
              className="signal-seg"
              style={vars({ "--beat": BEATS[i] + "s" })}
            >
              <i />
            </span>
          ))}
        </div>
        <div className="signal-labels">
          {labels.map((label, i) => (
            <span key={i} className="signal-label">
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* The layer is a size container, which is what lets the agent and
          the pile be positioned from the corner and pushed to the middle
          with `50cqw` / `50cqh`. Animating `left` and `top` between the
          two would look the same and relayout on every frame; a
          transform does not. */}
      <div className="signal-layer">
        <span className="signal-agent">
          <EyeMark size={21} decorative />

          {/* Three states, one per beat. The ring listens, the spinner
              works, the dots write. Each loop is on the clock, because
              none of them should stop just because the reader has. */}
          <span className="signal-agent-ring">
            <i />
          </span>
          <span className="signal-agent-spin">
            {/* The arc alone, with no ring behind it. A visible track
                turns the mark into a gauge — something with a total to
                fill — when all it means is that work is under way. */}
            <svg viewBox="0 0 24 24">
              <circle className="signal-spin-arc" cx="12" cy="12" r="9" />
            </svg>
          </span>
          <span className="signal-agent-typing">
            <i />
            <i />
            <i />
          </span>
        </span>

        <div className="signal-pile" data-p="2">
          <span className="signal-scan" data-p="2" />

          <ul className="signal-cards">
            {SIGNALS.map((s, i) => {
              const { delay, dur } = cardTiming(i);
              return (
                <li
                  key={`${s.from}${i}`}
                  className={`signal-card ${
                    s.rank === undefined
                      ? "signal-card--drop"
                      : "signal-card--keep"
                  }`}
                  style={vars({
                    "--slot": i,
                    "--rank": s.rank ?? 0,
                    "--x": `${s.x}px`,
                    "--y": `${s.y}px`,
                    "--in-delay": `${delay}s`,
                    "--in-dur": `${dur}s`,
                  })}
                >
                  {/* The box is an inner element so that the card itself
                      owns nothing but its position. The last beat has to
                      dissolve the box while keeping the card, and a
                      border animated twice — once to promote it, once to
                      remove it — cannot be done on one element. */}
                  <span className="signal-card-box">
                    <SourceIcon from={s.from} />
                    <span
                      className="signal-card-bar"
                      style={{ width: s.bar }}
                    />
                    <span className="signal-card-when" />
                  </span>

                  {/* What a kept signal becomes: a link, floating free.
                      Only the kept ones have it. The link sits outside
                      the box so the box can dissolve without taking it,
                      which also means a discarded card would keep its
                      link long after the card itself had gone. */}
                  {s.rank !== undefined && (
                    <svg
                      className="signal-card-link"
                      data-p="3"
                      viewBox="0 0 16 16"
                    >
                      <path d="M6.6 9.4a3 3 0 0 0 4.5.3l1.9-1.9a3 3 0 0 0-4.2-4.2l-1.1 1.1" />
                      <path d="M9.4 6.6a3 3 0 0 0-4.5-.3L3 8.2a3 3 0 0 0 4.2 4.2l1.1-1.1" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>
        </div>

        {/* What the agent writes. The lines grow from nothing rather than
            fading in: a bar that appears all at once has been placed,
            whereas one that extends has been written, and the difference
            is the whole of what this beat is claiming. */}
        <div className="signal-message" data-p="3">
          <span className="signal-message-head">
            <EyeMark size={14} decorative />
          </span>

          <span className="signal-message-lines">
            {[92, 100, 64].map((w, i) => (
              <i
                key={w}
                data-p="3"
                style={vars({
                  "--w": `${w}%`,
                  "--line-delay": `${0.6 + i * 0.4}s`,
                })}
              />
            ))}
            <span className="signal-caret" data-p="3">
              <i />
            </span>
          </span>

          <svg className="signal-message-check" data-p="3" viewBox="0 0 18 18">
            <circle cx="9" cy="9" r="8" />
            <path d="M5.4 9.2 7.9 11.7 12.7 6.4" />
          </svg>
        </div>
      </div>

      {/* The rail: three empty slots the width of the tile, scrolled
          sideways. It carries no picture — it is the control, laid over
          the drawing, and the only thing that knows which beat we are
          on. Its scrollbar is hidden and its overscroll is contained, so
          it never chains to the page or triggers a back gesture. */}
      <div className="signal-rail" ref={railRef}>
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

/**
 * Where a signal came from. Generic marks on purpose: a feed, a social
 * account, an API. Drawing a particular network's logo would put that
 * company's trademark in our marketing, and would claim an integration
 * by implication rather than by statement.
 */
function SourceIcon({ from }: { from: Source }) {
  return (
    <span className="signal-card-icon">
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      >
        {from === "rss" && (
          <>
            <circle
              cx="3.6"
              cy="12.4"
              r="1.2"
              fill="currentColor"
              stroke="none"
            />
            <path d="M2.6 8.2a5.2 5.2 0 0 1 5.2 5.2" strokeLinecap="round" />
            <path d="M2.6 4.2a9.2 9.2 0 0 1 9.2 9.2" strokeLinecap="round" />
          </>
        )}
        {from === "social" && (
          <>
            <circle cx="8" cy="8" r="2.7" />
            <path
              d="M10.7 8v1.5a1.9 1.9 0 0 0 3.8 0V8A6.5 6.5 0 1 0 10.6 13.9"
              strokeLinecap="round"
            />
          </>
        )}
        {from === "api" && (
          <>
            <path
              d="M6.3 2.6c-1.5 0-1.9.7-1.9 2v1.5c0 .9-.5 1.6-1.4 1.6.9 0 1.4.7 1.4 1.6v1.5c0 1.3.4 2 1.9 2"
              strokeLinecap="round"
            />
            <path
              d="M9.7 2.6c1.5 0 1.9.7 1.9 2v1.5c0 .9.5 1.6 1.4 1.6-.9 0-1.4.7-1.4 1.6v1.5c0 1.3-.4 2-1.9 2"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}
