"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
} from "next-themes";

/**
 * Routes that always render light, whatever the visitor's chosen theme.
 *
 * The landing page is marketing, not the product: it is a single designed
 * composition, and it was drawn light. Letting a returning user's dark
 * preference leak into it means maintaining a second art direction for a
 * page most people see once.
 *
 * Forcing rather than overriding: `forcedTheme` does not touch what is
 * stored, so leaving this route restores whatever the visitor had.
 */
const FORCED_LIGHT_ROUTES: ReadonlySet<string> = new Set(["/"]);

/**
 * Why the decision lives here rather than in the landing page itself:
 * next-themes ignores a nested provider outright —
 *
 *     ThemeProvider = props =>
 *       useContext(ctx) ? <>{props.children}</> : <Theme {...props} />
 *
 * — so wrapping the landing in a second provider with `forcedTheme` would
 * silently do nothing. There is one provider, at the root, and the route
 * has to reach it.
 *
 * Reading the pathname here also means the theme is correct in the
 * blocking script next-themes injects, so a direct hit on the landing
 * paints light immediately instead of flashing dark first.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const pathname = usePathname();
  return (
    <NextThemesProvider
      {...props}
      forcedTheme={FORCED_LIGHT_ROUTES.has(pathname) ? "light" : undefined}
    >
      {children}
    </NextThemesProvider>
  );
}
