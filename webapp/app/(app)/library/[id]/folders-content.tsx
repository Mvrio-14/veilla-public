import { notFound, redirect } from "next/navigation";
import { FoldersView } from "@/components/folders/folders-view";
import { fetchFolder } from "@/lib/api";
import { requireViewer } from "@/lib/auth/viewer";
import { CanWriteProvider } from "@/lib/auth/can-write";

/**
 * Data-dependent render for a specific folder. Behind <Suspense> in
 * page.tsx so the layout shell streams first.
 */
export async function FoldersContent({
  folderId,
  storyIdFromUrl,
}: {
  folderId: string;
  /** `?story=X` parsed by the route, propagated to FoldersView so the
   *  detail panel auto-opens on landing (mirrors /watch). */
  storyIdFromUrl?: number | null;
}) {
  const { accessToken, canWrite } = await requireViewer(`/library/${folderId}`);

  let data;
  try {
    data = await fetchFolder(folderId, accessToken);
  } catch (err) {
    if (err instanceof Response) {
      if (err.status === 404) notFound();
      if (err.status === 401 || err.status === 403) {
        redirect(`/login?next=/library/${folderId}`);
      }
    }
    throw err;
  }

  return (
    <CanWriteProvider value={canWrite}>
      <FoldersView
        data={data}
        folderId={folderId}
        storyIdFromUrl={storyIdFromUrl ?? null}
      />
    </CanWriteProvider>
  );
}
