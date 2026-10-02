import { Suspense } from "react";
import { FoldersSkeleton } from "@/components/skeletons/folders-skeleton";
import { FoldersContent } from "./folders-content";

/**
 * Folder detail route. Async because the dynamic-route params need to
 * be awaited (Next.js 16 convention), then renders the data-dependent
 * `<FoldersContent />` inside a Suspense boundary so the skeleton
 * streams on hard refresh — same pattern as `/watch`, see that page's
 * JSDoc for the rationale (cookies-in-layout bypassing `loading.tsx`).
 *
 * Optional `?story=X` param mirrors the /watch convention — a link can
 * point straight at one story of the folder. The SPA opens the detail
 * panel on that story when present.
 */
export default async function FolderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const rawStory = sp.story;
  const storyParam = Array.isArray(rawStory) ? rawStory[0] : rawStory;
  const parsed = storyParam ? Number(storyParam) : NaN;
  const storyIdFromUrl = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  return (
    <Suspense fallback={<FoldersSkeleton />}>
      <FoldersContent folderId={id} storyIdFromUrl={storyIdFromUrl} />
    </Suspense>
  );
}
