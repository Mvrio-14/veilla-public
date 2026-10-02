import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  type Locale,
} from "./config";

/**
 * Resolve the active locale per request. The cookie wins if set; otherwise
 * we sniff Accept-Language for a French preference and fall back to the
 * default (English). Loaded lazily by next-intl on each render that uses
 * translations — server components included.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE)?.value;

  let locale: Locale = DEFAULT_LOCALE;
  if (isSupportedLocale(fromCookie)) {
    locale = fromCookie;
  } else {
    const accept = (await headers()).get("accept-language") ?? "";
    if (/\bfr\b/i.test(accept)) locale = "fr";
  }

  // SUPPORTED_LOCALES is the SoT; keeps TS narrow on the import filename.
  if (!SUPPORTED_LOCALES.includes(locale)) locale = DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
