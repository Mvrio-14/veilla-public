import { Suspense } from "react";
import { WatchSkeleton } from "@/components/skeletons/watch-skeleton";
import { WatchContent } from "./watch-content";

/**
 * Watch route. Two URL params seed the SPA on mount:
 *
 *   ?story=X  — open the detail panel on cluster X. Set/cleared as the
 *               user clicks through stories (synced via history.replaceState
 *               in WatchMain). Same pattern as Feedly's deep-linkable
 *               article view.
 *
 *   ?view=Y   — apply the saved view Y as the active filter. Used by
 *               shared-view notifications (in-app + email) to deep-link
 *               directly into the view. Same
 *               state-as-URL convention as Linear/Notion/Airtable —
 *               no per-view route, the existing /watch route is just
 *               parametrized.
 *
 * Both params can combine: `/watch?view=Y&story=X` lands in view Y
 * with story X expanded inside it.
 *
 * `searchParams` is a Promise in Next.js 16 — must be awaited before
 * indexing.
 *
 * Why <Suspense> here even though the route has a `loading.tsx`:
 *   Next.js 16 silently bypasses a route-segment `loading.tsx` when
 *   any ancestor layout reads uncached data (cookies / headers / non-
 *   cached fetches). The `(app)` layout calls `requireSession()`
 *   which touches cookies, so on a hard refresh the user sees a
 *   blank/frozen window for the entire backend response time. An
 *   explicit Suspense boundary inside the page forces Next to stream
 *   the shell + skeleton immediately and replace it when WatchContent
 *   resolves — matching the Feedly/Inoreader behaviour on refresh.
 *
 *   Docs: `node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md`
 *         section "With loading.js", paragraphs about uncached layout
 *         data blocking the loading fallback.
 */
export default async function WatchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const rawStory = params.story;
  const storyParam = Array.isArray(rawStory) ? rawStory[0] : rawStory;
  const parsed = storyParam ? Number(storyParam) : NaN;
  const storyIdFromUrl = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  const rawView = params.view;
  const viewParam = Array.isArray(rawView) ? rawView[0] : rawView;
  // View IDs are UUIDs — a length sanity check is enough to reject
  // garbage without dragging a full UUID regex into the route. The
  // SPA does its own existence check against `data.views`.
  const viewIdFromUrl =
    typeof viewParam === "string" && viewParam.length >= 8 && viewParam.length <= 64
      ? viewParam
      : null;

  return (
    <Suspense fallback={<WatchSkeleton />}>
      <WatchContent
        storyIdFromUrl={storyIdFromUrl}
        viewIdFromUrl={viewIdFromUrl}
      />
    </Suspense>
  );
}
