"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";

/**
 * Authenticated-app error boundary. Lives under `(app)/` so the sidebar +
 * topbar still render around it (it's wrapped BY (app)/layout.tsx, not
 * the reverse) — the chrome stays usable and only the content area shows
 * the fallback. Catches any uncaught throw from /watch, /library,
 * /settings server fetches — most realistically a Render API cold-start
 * 500 or a transient backend hiccup.
 *
 * The intl provider sits in the root layout, above this boundary, so it
 * is still mounted when an error lands here and `useTranslations` is
 * safe. Errors above it are caught by app/global-error.tsx instead.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("appError");

  useEffect(() => {
    console.error("[app error boundary]", error.digest ?? "", error);
    // No-op unless a DSN is configured.
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="flex-1 flex items-center justify-center min-h-0 px-6">
      <div className="flex flex-col items-center text-center gap-4 max-w-md">
        <div className="text-[40px] font-semibold tracking-[-0.02em] text-text">
          !
        </div>
        <h2 className="text-[18px] font-semibold tracking-[-0.012em] text-text">
          {t("title")}
        </h2>
        <p className="text-[14px] text-text-2 leading-relaxed">{t("body")}</p>
        <Button variant="outline" size="lg" onClick={() => reset()}>
          {t("retry")}
        </Button>
      </div>
    </div>
  );
}
