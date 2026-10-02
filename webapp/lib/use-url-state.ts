"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";

/**
 * Read and write one query parameter as component state.
 *
 * Filters, grouping, search and the selected period live in the URL, not
 * in `useState`. That buys three things at once: a filtered view is a
 * link you can send, it survives a refresh, and the back button undoes a
 * filter instead of leaving the screen.
 *
 * Writes go through the native History API, not `router.replace`.
 * Next.js syncs native history calls into `useSearchParams`, so the state
 * updates without a server round-trip — where `router.replace` would
 * re-run the server component on every keystroke of a search box.
 *
 * ## push or replace
 *
 * Which one depends on whether the change was a discrete decision:
 *
 *   - **push** (default) — clicking a filter value or a grouping axis is
 *     an intent. The back button should undo it, and land you on the view
 *     you were looking at rather than throwing you off the screen.
 *   - **replace** — typing in a search box. Twelve characters are one
 *     intent, not twelve; pushing each keystroke turns the back button
 *     into a very slow backspace.
 *
 * Arrays serialise as comma-separated values, which keeps a shared link
 * readable (`?health=error,warn`) — the point of putting state in the URL
 * is partly that a human can read it.
 *
 * Pass the type explicitly when the default is a literal
 * (`useUrlState<string>("q", "")`), or TypeScript narrows the setter to
 * that one literal.
 */
export function useUrlState<T extends string | string[]>(
  key: string,
  fallback: T,
  { history = "push" }: { history?: "push" | "replace" } = {},
): [T, (next: T) => void] {
  const searchParams = useSearchParams();

  // Callers pass the fallback inline, so `[]` is a fresh reference on
  // every render and would invalidate every memo below it. Collapsing it
  // to its serialised form gives a primitive that only changes when the
  // value genuinely changes — a stable dependency without a ref, which
  // must not be read during render anyway.
  const isArray = Array.isArray(fallback);
  const fallbackKey = isArray ? (fallback as string[]).join(",") : (fallback as string);

  const value = React.useMemo(() => {
    const raw = searchParams.get(key);
    const source = raw === null || raw === "" ? fallbackKey : raw;
    if (!isArray) return source as T;
    return (source ? source.split(",").filter(Boolean) : []) as T;
  }, [searchParams, key, isArray, fallbackKey]);

  const setValue = React.useCallback(
    (next: T) => {
      const params = new URLSearchParams(window.location.search);
      const serialised = Array.isArray(next) ? next.join(",") : next;

      // An empty or default value is absence, not `?health=` or
      // `?group=kind`. Keeping the key would make two identical views
      // produce two different URLs — and two different shared links.
      if (!serialised || serialised === fallbackKey) {
        params.delete(key);
      } else {
        params.set(key, String(serialised));
      }

      const qs = params.toString();
      const url = qs
        ? `${window.location.pathname}?${qs}`
        : window.location.pathname;

      // No-op writes still fire on every keystroke that doesn't change
      // the value (autocomplete, repeated selection) — skip them so the
      // history stack only records real transitions.
      if (url === window.location.pathname + window.location.search) return;

      if (history === "push") {
        window.history.pushState(null, "", url);
      } else {
        window.history.replaceState(null, "", url);
      }
    },
    [key, fallbackKey, history],
  );

  return [value, setValue];
}
