import { SourcesFeedsClient } from "@/components/admin/sources-feeds-client";

/**
 * /admin/sources — unified Sources + Feeds management surface.
 *
 * Layout: master-detail. Left = sources list. Right = feeds of the
 * selected source. Top bar: "+ Add feed" button opens the probe-then-save
 * dialog. Dev-grade UI — table-ish, monospaced, no animations.
 *
 * The page is intentionally a thin server-component shell that delegates
 * EVERYTHING to the client component below — admin tooling is heavily
 * interactive and there's no value in RSC-streaming a tooling surface.
 */
export default function AdminSourcesPage() {
  return <SourcesFeedsClient />;
}
