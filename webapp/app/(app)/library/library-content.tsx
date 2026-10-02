import { redirect } from "next/navigation";
import { SavedView } from "@/components/saved/saved-view";
import { fetchSaved } from "@/lib/api";
import { requireViewer } from "@/lib/auth/viewer";
import { CanWriteProvider } from "@/lib/auth/can-write";

/**
 * Data-dependent Library render. Same streaming pattern as WatchContent —
 * sits behind a <Suspense> boundary in page.tsx so the shell paints first.
 */
export async function LibraryContent() {
  const { accessToken, canWrite } = await requireViewer("/library");

  let data;
  try {
    data = await fetchSaved(accessToken);
  } catch (err) {
    if (err instanceof Response) {
      if (err.status === 401 || err.status === 403) {
        redirect("/login?next=/library");
      }
    }
    throw err;
  }

  return (
    <CanWriteProvider value={canWrite}>
      <SavedView initialData={data} />
    </CanWriteProvider>
  );
}
