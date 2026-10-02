import * as React from "react";
import { render as rtlRender, type RenderOptions } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import messages from "@/messages/fr.json";

/**
 * Render a component inside the providers the app always gives it.
 *
 * Currently that is next-intl, without which any component calling
 * `useTranslations` throws before it renders a single node.
 *
 * ## Why the real messages and not a stub
 *
 * Loading `fr.json` costs nothing here and buys two things a stub
 * cannot: a missing key fails the test that needs it, and assertions
 * can look for the words a person actually reads. Tests written
 * against `t("foo.bar")` placeholders pass happily while the interface
 * shows nothing.
 *
 * French because it is the project's first locale; anything asserting
 * on wording is therefore asserting on French strings.
 */
export function render(ui: React.ReactElement, options?: RenderOptions) {
  function Providers({ children }: { children: React.ReactNode }) {
    return (
      <NextIntlClientProvider locale="fr" messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return rtlRender(ui, { wrapper: Providers, ...options });
}

export * from "@testing-library/react";
// Deliberately last: shadows Testing Library's own `render` with the
// wrapped one, so a test that imports from here cannot accidentally get
// the bare version and fail on a missing provider.
export { render as renderWithProviders };
