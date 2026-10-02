import Link from "next/link";

/**
 * Inline 403 / 500 page for /admin/*.
 *
 * Rendered instead of redirecting when the admin gate fails. Showing a
 * static page (instead of bouncing to /watch) prevents the infinite
 * redirect loop we observed when a user without a public.users row hit
 * /admin: /admin → /watch → /me 404 → / → /watch → ...
 *
 * Two reasons we end up here:
 *  - "forbidden": authenticated user is not in ADMIN_EMAILS
 *  - "error":     backend unreachable (network / 5xx)
 */
export function AdminForbidden({
  email,
  reason,
  message,
}: {
  email: string | null;
  reason: "forbidden" | "error";
  message?: string;
}) {
  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-lg shadow-sm p-8 font-mono text-sm">
        <div className="text-xs uppercase tracking-wider text-yellow-700 bg-yellow-100 inline-block px-2 py-0.5 rounded mb-4">
          /admin
        </div>

        {reason === "forbidden" ? (
          <>
            <h1 className="text-lg font-semibold mb-2">Accès refusé</h1>
            <p className="text-zinc-600 mb-4">
              Ce compte n&apos;est pas autorisé à accéder à l&apos;interface
              admin.
            </p>
            {email && (
              <p className="text-xs text-zinc-500 mb-6">
                Signed in as <span className="font-medium">{email}</span>
              </p>
            )}
            <p className="text-xs text-zinc-500 mb-6">
              Vérifie que l&apos;email est listé dans
              <span className="mx-1 px-1 bg-zinc-100 rounded">
                ADMIN_EMAILS
              </span>
              côté backend (Render env vars).
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold mb-2">Backend injoignable</h1>
            <p className="text-zinc-600 mb-4">
              Impossible de vérifier les droits admin pour le moment.
            </p>
            {message && (
              <p className="text-xs text-zinc-500 mb-6 break-all">
                {message}
              </p>
            )}
          </>
        )}

        <div className="flex gap-2 text-xs">
          <Link
            href="/watch"
            className="px-3 py-1.5 bg-zinc-900 text-white rounded hover:bg-zinc-700"
          >
            Aller à /watch
          </Link>
          <Link
            href="/login"
            className="px-3 py-1.5 border border-zinc-300 rounded hover:bg-zinc-100"
          >
            Se reconnecter
          </Link>
        </div>
      </div>
    </main>
  );
}
