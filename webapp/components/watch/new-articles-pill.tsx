"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Loader2 } from "lucide-react";
import { useNewArticles } from "@/lib/realtime/use-new-articles";

/**
 * Sticky "X new articles — refresh" pill at the top of the /watch
 * feed. Surfaces broadcasts from the ingest worker so the user knows
 * fresh content is ready without polling.
 *
 * Loading-state UX (via React's `useTransition`):
 *   - idle      → "{count} nouveaux articles — actualiser" + ↑ icon
 *   - clicked   → pill stays visible, text morphs to "Actualisation…"
 *                 with a spinning icon — `router.refresh()` runs in the
 *                 background, the SSR re-fetch can take a couple seconds
 *                 on a fresh corpus and without this the user is left
 *                 with no visual signal
 *   - completed → count is reset (= 0), isPending flips back, pill hides
 *
 * Style pattern lifted from Twitter / Reddit / Slack — small floating
 * accent pill, low-friction dismiss.
 */
export function NewArticlesPill({ slug }: { slug: string }) {
  const router = useRouter();
  const { count, reset } = useNewArticles(slug);
  const [isPending, startTransition] = React.useTransition();

  // Pill visible whenever there's something to surface OR a refresh
  // is mid-flight. The dual condition keeps the pill on screen during
  // the silent window between "user clicked" and "new content
  // committed", so the user gets feedback that something's happening.
  if (count === 0 && !isPending) return null;

  const handleClick = () => {
    // Hide the count badge immediately — the spinner state replaces
    // it. Reset is synchronous, the visual swap happens on the next
    // render.
    reset();
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="flex justify-center px-3.5 pb-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="
          inline-flex items-center gap-1.5
          px-3.5 py-1.5 rounded-full
          bg-accent text-bg shadow-md
          text-[12px] font-semibold tracking-[-0.005em]
          hover:brightness-110 cursor-pointer transition-all
          disabled:cursor-progress disabled:hover:brightness-100
        "
      >
        {isPending ? (
          <>
            <Loader2 size={12} strokeWidth={2.4} className="animate-spin" />
            <span>Actualisation…</span>
          </>
        ) : (
          <>
            <ArrowUp size={12} strokeWidth={2.4} />
            <span>
              {count === 1
                ? "1 nouvel article — actualiser"
                : `${count} nouveaux articles — actualiser`}
            </span>
          </>
        )}
      </button>
    </div>
  );
}
