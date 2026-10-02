"use client";

import * as React from "react";

/**
 * Whether the signed-in account may create things — save a story, follow
 * it, build a view or a folder.
 *
 * ## Why a context and not a prop
 *
 * The answer is ambient: every action button in the app needs it, and the
 * buttons live several levels below the page that knows it. Threading a
 * prop through each intermediate component would work right up until
 * someone adds a seventh call site and forgets — and the failure mode is
 * an enabled button that the API then refuses, which reads as a bug rather
 * than as a limit.
 *
 * ## Why the default is false
 *
 * A component rendered outside the provider gets `false`, so its controls
 * appear disabled rather than inviting a click that cannot succeed. Same
 * direction as the API middleware: refuse by default, allow deliberately.
 * An interface that is wrongly restrictive is a visible bug someone
 * reports; one that is wrongly permissive is a confusing product.
 *
 * ## What this is NOT
 *
 * It is not a security boundary. It decides what to *show*; the API
 * decides what to *allow*, in `src/write_access.py`. Both read the same
 * value — `can_write` from `/me` — so they agree, but the browser's copy
 * is a convenience and is assumed to be tampered with.
 */
const CanWriteContext = React.createContext(false);

export function CanWriteProvider({
  value,
  children,
}: {
  value: boolean;
  children: React.ReactNode;
}) {
  return (
    <CanWriteContext.Provider value={value}>
      {children}
    </CanWriteContext.Provider>
  );
}

export function useCanWrite(): boolean {
  return React.useContext(CanWriteContext);
}
