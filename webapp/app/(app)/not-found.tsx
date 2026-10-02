/**
 * Authenticated-app 404 page. Lives under `(app)/` so the sidebar +
 * topbar still render around it; we only fill the content area with
 * a centered message. Triggered by any `notFound()` call in a nested
 * route (e.g. /library/{id} when the folder doesn't exist).
 */
export default function NotFound() {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0 px-6">
      <div className="flex flex-col items-center text-center gap-4 max-w-md">
        <div className="text-[40px] font-semibold tracking-[-0.02em] text-text">
          404
        </div>
        <p className="text-[14px] text-text-2 leading-relaxed">
          Cette page n&apos;existe pas, ou n&apos;est plus accessible.
        </p>
      </div>
    </div>
  );
}
