"use client";

import { useTranslations } from "next-intl";

/**
 * Localized labels for the 16 canonical normalizer categories.
 *
 * Backend stores the raw EN canonical strings ("Domestic Politics",
 * "Technology & AI", etc.) in articles.category and stories.categories.
 * The UI displays them everywhere (cluster cards, detail panel,
 * preferences picker, filter dialog), so we centralize the
 * EN→display-lang lookup here.
 *
 * Wraps `useTranslations("filtersDialog.categoryLabels")` from next-intl so
 * the label dictionary stays alongside the rest of the i18n strings
 * (`webapp/messages/{en,fr}.json`). If a backend tag falls outside the
 * known 16-bucket taxonomy (= future-proofing), we return the raw
 * canonical string unchanged — better than a blank chip.
 */

const KNOWN_CATEGORIES = new Set([
  "Domestic Politics",
  "Geopolitics & Conflicts",
  "Justice & Legal Affairs",
  "Crime & Public Safety",
  "Economy",
  "Finance & Markets",
  "Business & Industry",
  "Energy & Climate",
  "Technology & AI",
  "Science",
  "Health",
  "Society & Labour",
  "Education",
  "Media & Culture",
  "Sport",
  "Other",
]);

export function useCategoryLabel(): (canonical: string) => string {
  const t = useTranslations("filtersDialog.categoryLabels");
  return (canonical: string) =>
    KNOWN_CATEGORIES.has(canonical) ? t(canonical) : canonical;
}
