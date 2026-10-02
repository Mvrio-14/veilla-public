/**
 * i18n configuration.
 *
 * Two locales: "en" (default fallback) and "fr". Selection is driven by a
 * cookie (`NEXT_LOCALE`) set by the in-app language switcher. No URL
 * prefix — every route stays at its current path; the cookie tells the
 * server which message catalog to inject.
 *
 * If the cookie is missing or invalid (e.g. anon visitor on a public
 * watch), we sniff the browser's `Accept-Language` header for a French
 * preference and fall back to English otherwise. The startup is currently
 * French-leaning so this gives the best first impression in either case.
 */

export const SUPPORTED_LOCALES = ["en", "fr"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}
