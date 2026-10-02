import { Suspense } from "react";
import { MonitorsView } from "@/components/monitors/monitors-view";
import { Loader } from "@/components/ui/loader";
import { fetchMonitors } from "@/lib/api";
import { loadForPage } from "@/lib/auth/page-data";

/** Monitors: what the reader follows, and whether it works. */
export default function MonitorsPage() {
  return (
    <Suspense fallback={<Loader />}>
      <MonitorsContent />
    </Suspense>
  );
}

async function MonitorsContent() {
  const { data } = await loadForPage("/monitors", fetchMonitors);
  return <MonitorsView monitors={data} />;
}
