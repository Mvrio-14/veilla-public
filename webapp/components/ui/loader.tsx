"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Default loading fallback for slow routes (`app/<route>/loading.tsx`)
 * and inline anywhere a small indeterminate progress hint is needed.
 *
 * Visual: classic rotating spinner from lucide-react (Tailwind built-in
 * `animate-spin`) plus a short status line. The label defaults to the
 * `loading.default` translation key but callers can override via the
 * `label` prop.
 */
export function Loader({ label }: { label?: string }) {
  const t = useTranslations("loading");
  const text = label ?? t("default");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 min-h-[60vh] w-full">
      <Loader2
        className="h-8 w-8 text-text-2 animate-spin"
        aria-label={t("default")}
        role="status"
      />
      {text && (
        <span className="text-[12px] text-text-3">{text}</span>
      )}
    </div>
  );
}
