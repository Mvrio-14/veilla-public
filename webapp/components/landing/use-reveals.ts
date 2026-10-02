"use client";

import * as React from "react";

/**
 * Reveals anything marked `data-reveal` the first time it enters the
 * viewport, by setting `data-shown` on it. The movement itself is a
 * transition in `globals.css`; this only decides when.
 *
 * One observer for the whole page rather than one per section: the
 * browser batches its work either way, and a section that wants a reveal
 * only has to put an attribute on an element — it needs no hook, no
 * wrapper component and no client boundary of its own, which is why the
 * sections using it are still server components.
 *
 * Each element is unobserved as soon as it has been shown. A reveal that
 * replays every time the reader scrolls past is not a reveal, it is a
 * flicker; and unobserving means the observer empties itself as the page
 * is read instead of holding on to every node.
 *
 * It writes an attribute rather than setting state: the value is only
 * read by CSS, so a re-render would buy nothing and cost one per
 * element.
 *
 * ## Why it re-scans
 *
 * A single pass at mount is not enough, because marked elements can
 * arrive later: switching language re-renders the page from the server
 * and replaces whole subtrees. An element that is never observed keeps
 * the `opacity: 0` that `[data-reveal]` starts it with, and nothing
 * reports it — the failure is an invisible section, not an error. So a
 * `MutationObserver` watches for new nodes and hands them over.
 *
 * Re-observing an element already being observed is a no-op per spec, so
 * the scan can be blunt: it asks for everything still unshown and offers
 * the lot. That set shrinks towards empty as the page is read.
 */
export function useReveals() {
  React.useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          (entry.target as HTMLElement).dataset.shown = "";
          observer.unobserve(entry.target);
        }
      },
      // The bottom of the root is pulled up by a quarter of the
      // viewport, so an element has to be properly on screen — not just
      // peeking over the fold — before it moves. Firing at the edge made
      // the figures animate while they were still half below it, which
      // reads as the page reacting to the scroll rather than as the row
      // arriving. Raise this number to make everything reveal later.
      { rootMargin: "0px 0px -24% 0px", threshold: 0.25 },
    );

    const scan = () => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "[data-reveal]:not([data-shown])",
      )) {
        observer.observe(element);
      }
    };

    scan();

    const arrivals = new MutationObserver(scan);
    arrivals.observe(document.body, { childList: true, subtree: true });

    return () => {
      arrivals.disconnect();
      observer.disconnect();
    };
  }, []);
}
