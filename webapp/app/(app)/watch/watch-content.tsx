import { notFound, redirect } from "next/navigation";
import { WatchMain } from "@/components/watch/watch-main";
import { fetchWatch } from "@/lib/api";
import { requireViewer } from "@/lib/auth/viewer";
import { CanWriteProvider } from "@/lib/auth/can-write";

/**
 * Data-dependent Watch render. Lives behind a <Suspense> boundary in
 * page.tsx so the (app) layout's shell can paint before this resolves.
 *
 * Owns: requireViewer (calls /me), then fetchWatch (calls /watch).
 *
 * URL params propagated to WatchMain:
 *   - `storyIdFromUrl` — seeds activeStoryId, auto-opens DetailPanel.
 *   - `viewIdFromUrl`  — seeds currentViewId at mount, applies the
 *     view's criteria as the active filter (used by shared-view deep-
 *     links). Wins over sessionStorage on landing so a notification
 *     click always lands in the right context.
 *
 * No additional fetch needed for either — both are looked up against
 * the `/watch` payload (data.stories / data.views) client-side.
 */
export async function WatchContent({
  storyIdFromUrl,
  viewIdFromUrl,
}: {
  storyIdFromUrl: number | null;
  viewIdFromUrl: string | null;
}) {
  const { slug, accessToken, canWrite } = await requireViewer("/watch");

  let data;
  try {
    data = await fetchWatch(slug, 24, accessToken);
  } catch (err) {
    if (err instanceof Response) {
      if (err.status === 404) notFound();
      if (err.status === 401 || err.status === 403) redirect("/login?next=/watch");
      // Any other non-OK status: convert the Response into a real Error
      // before re-throwing so Sentry receives a useful message + body
      // instead of "[object Response]". Body capped to avoid sending
      // huge payloads (typically a 500 backend error is a short stack).
      const body = await err.text().catch(() => "<no body>");
      throw new Error(
        `Backend /watch failed: ${err.status} ${err.statusText} — ${body.slice(0, 500)}`
      );
    }
    throw err;
  }

  return (
    <CanWriteProvider value={canWrite}>
      <WatchMain
        data={data}
        storyIdFromUrl={storyIdFromUrl}
        viewIdFromUrl={viewIdFromUrl}
      />
    </CanWriteProvider>
  );
}
