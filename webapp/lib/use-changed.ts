"use client";

import * as React from "react";

/**
 * True on the render where `value` differs from the previous render.
 *
 * This is React's documented way to adjust state when a prop changes,
 * packaged so the fifteen places that need it do not each grow their
 * own copy:
 *
 *     const [draft, setDraft] = React.useState(serverValue);
 *     if (useChanged(serverValue)) setDraft(serverValue);
 *
 * ## Why not an effect
 *
 * The effect version — `useEffect(() => setDraft(serverValue), [serverValue])`
 * — renders the component with the stale value, then immediately
 * re-renders with the fresh one. Users can see that first frame, and
 * anything reading the state in between reads the old value. Setting
 * state during render instead makes React discard the in-progress
 * render and redo it before touching the DOM, so the stale value never
 * reaches the screen.
 *
 * It is not a re-render loop: React only repeats the work of this one
 * component, and the next render sees `value === prev`, so the branch
 * does not fire again.
 *
 * ## Identity, not equality
 *
 * Comparison is `Object.is`. A prop rebuilt on every parent render —
 * `data.views ?? []`, a fresh array each time — would therefore look
 * changed on every render and reset state forever. Memoise such a prop
 * at its source, or pass a stable field of it, before reaching for
 * this hook.
 */
export function useChanged<T>(value: T): boolean {
  const [previous, setPrevious] = React.useState(value);
  if (!Object.is(value, previous)) {
    setPrevious(value);
    return true;
  }
  return false;
}
