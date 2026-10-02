import { Suspense } from "react";
import { AgentsView } from "@/components/signal/agents-view";
import { Loader } from "@/components/ui/loader";
import { fetchWatchers } from "@/lib/api";
import { CanWriteProvider } from "@/lib/auth/can-write";
import { loadForPage } from "@/lib/auth/page-data";

/** Agents: every standing request of the reader. */
export default function AgentsPage() {
  return (
    <Suspense fallback={<Loader />}>
      <AgentsContent />
    </Suspense>
  );
}

async function AgentsContent() {
  const { data, canWrite } = await loadForPage("/signal/agents", fetchWatchers);
  return (
    <CanWriteProvider value={canWrite}>
      <AgentsView agents={data} />
    </CanWriteProvider>
  );
}
