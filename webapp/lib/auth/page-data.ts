import { notFound, redirect } from "next/navigation";
import { requireViewer } from "./viewer";

/**
 * Load a page's data with the viewer's token, the way every page of the
 * app handles a refusal: a lapsed session goes to the login page and
 * back, a missing resource is the not-found page, anything else throws
 * to the error boundary.
 *
 * `path` is the page's own URL, where the login page sends the reader
 * back.
 */
export async function loadForPage<T>(
  path: string,
  load: (accessToken: string) => Promise<T>,
): Promise<{ data: T; canWrite: boolean }> {
  const { accessToken, canWrite } = await requireViewer(path);
  try {
    return { data: await load(accessToken), canWrite };
  } catch (err) {
    if (err instanceof Response) {
      if (err.status === 401 || err.status === 403) {
        redirect(`/login?next=${encodeURIComponent(path)}`);
      }
      if (err.status === 404) notFound();
    }
    throw err;
  }
}
