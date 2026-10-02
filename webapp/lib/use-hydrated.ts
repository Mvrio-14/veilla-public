"use client";

import * as React from "react";

/** Never fires: the answer flips exactly once, at hydration, and React
 *  re-reads the snapshot then without being told. */
const subscribe = () => () => {};

/**
 * False during server rendering and the hydration pass, true afterwards.
 *
 * The use for it is reading something only the browser knows — the
 * document's language, a theme resolved from storage, a media query —
 * without the server and the client disagreeing about the first paint.
 *
 * ## Why not the `useEffect(() => setMounted(true), [])` idiom
 *
 * It does the same thing by rendering once with the wrong answer and
 * then correcting it, which React's own lint rules now flag. This
 * asks React the question directly: `useSyncExternalStore` takes a
 * separate server snapshot, so the mismatch it is guarding against
 * cannot happen, and there is no state to update.
 */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
