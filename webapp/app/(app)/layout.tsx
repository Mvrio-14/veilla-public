import { AppShell } from "@/components/app/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { RealtimeProvider } from "@/lib/realtime/provider";
import { RealtimeRefresher } from "@/lib/realtime/realtime-refresher";
import { requireSession } from "@/lib/auth/viewer";

/**
 * Authenticated server shell for /watch, /library, /inbox, /settings.
 *
 * Does the cheap session-only auth gate (no /me round-trip) before
 * delegating to `<AppShell />`, the client component that owns the
 * collapsible-sidebar context and the actual chrome layout. Splitting
 * server gate / client chrome keeps the first paint instant and lets
 * the sidebar toggle live in a Context-aware tree.
 *
 * `<RealtimeProvider>` wraps everything so the WebSocket channel
 * spans the whole authenticated app and survives client-side
 * navigation between routes (no tear-down/rebuild). The provider is
 * a client component — it opens the channel on first paint and
 * doesn't block the layout's first render.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();

  return (
    <RealtimeProvider>
      {/* Auto-refresh the current route's RSC data on Realtime events.
       *  Lives next to AppShell (inside the Provider) so it has access
       *  to the same Realtime context but doesn't pollute the visual
       *  tree — it renders null. */}
      <RealtimeRefresher />
      <ToastProvider>
        <AppShell>{children}</AppShell>
      </ToastProvider>
    </RealtimeProvider>
  );
}
