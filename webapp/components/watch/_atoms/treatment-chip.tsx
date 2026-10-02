"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * Visible "treatment" chip next to article titles.
 *
 * `kind` is the backend `article_type` value (always canonical EN), one
 * of the 7 values produced by the normalizer: news / feature / opinion /
 * interview / recap / multimedia / institutional.
 *
 * We localize via the `filtersDialog.articleTypeLabels` next-intl group — the
 * same map the preferences form + advanced-filters dialog use, so a
 * relabel propagates everywhere. Unknown / future values fall back to
 * the raw kind lowercased so the chip never disappears silently.
 */
const KNOWN_TYPES = new Set([
  "news",
  "feature",
  "opinion",
  "interview",
  "recap",
  "multimedia",
  "institutional",
]);

const CHIP_CLASS = cn(
  "inline-flex items-center px-1.5 py-px rounded-full",
  "text-[9.5px] font-semibold lowercase leading-[1.4]",
  "whitespace-nowrap shrink-0 border",
  "bg-bg-sub text-text-3 border-border",
);

export function TreatmentChip({ kind }: { kind?: string | null }) {
  const t = useTranslations("filtersDialog.articleTypeLabels");
  if (!kind) return null;
  const raw = kind.toLowerCase();
  const label = KNOWN_TYPES.has(raw) ? t(raw) : raw;
  return <span className={CHIP_CLASS}>{label}</span>;
}
