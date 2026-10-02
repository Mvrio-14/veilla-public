import { Suspense } from "react";
import { LibrarySkeleton } from "@/components/skeletons/library-skeleton";
import { LibraryContent } from "./library-content";

/**
 * Library route. Same Suspense pattern as `/watch` — see the JSDoc on
 * `app/(app)/watch/page.tsx` for the full rationale. Short version:
 * the (app) layout reads cookies via `requireSession()`, which makes
 * Next.js 16 silently bypass the route-segment `loading.tsx` on hard
 * refresh. An explicit Suspense boundary inside the page forces the
 * shell + skeleton to stream first, and the content swaps in when
 * `<LibraryContent />`'s data fetch resolves.
 */
export default function LibraryPage() {
  return (
    <Suspense fallback={<LibrarySkeleton />}>
      <LibraryContent />
    </Suspense>
  );
}
