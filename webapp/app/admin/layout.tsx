import { requireAdmin } from "@/lib/auth/admin";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminForbidden } from "@/components/admin/admin-forbidden";

/**
 * Server gate + chrome for the /admin/* dev tooling.
 *
 * - Verifies admin status via `GET /admin/me` (= ADMIN_EMAILS check
 *   server-side).
 * - **No redirect loop**: non-admins are rendered an inline 403 page,
 *   NOT redirected. (The previous version redirected to /watch, which
 *   created an infinite loop for any user whose /watch path was also
 *   broken — e.g. a fresh account without a public.users row.)
 * - Unauthenticated users hit `requireSession` first and are sent to
 *   /login, which is guaranteed to be reachable.
 *
 * Each page underneath can re-call `requireAdmin()` if it needs the
 * accessToken or email — the call is cached per request so there is no
 * additional round-trip.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const result = await requireAdmin();

  if (result.kind === "forbidden") {
    return <AdminForbidden email={result.email} reason="forbidden" />;
  }
  if (result.kind === "error") {
    return <AdminForbidden email={null} reason="error" message={result.message} />;
  }

  return <AdminShell adminEmail={result.viewer.email}>{children}</AdminShell>;
}
