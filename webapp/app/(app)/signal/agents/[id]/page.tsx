import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AgentDetail } from "@/components/signal/agent-detail";
import { Loader } from "@/components/ui/loader";
import { fetchDecisions, fetchMonitors, fetchWatcher } from "@/lib/api";
import { CanWriteProvider } from "@/lib/auth/can-write";
import { loadForPage } from "@/lib/auth/page-data";

/** One agent: what it kept, and what it is asked. */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <Suspense fallback={<Loader />}>
      <AgentContent id={id} />
    </Suspense>
  );
}

async function AgentContent({ id }: { id: number }) {
  const { data, canWrite } = await loadForPage(`/signal/agents/${id}`, (token) =>
    Promise.all([fetchWatcher(id, token), fetchDecisions(token), fetchMonitors(token)]),
  );
  const [agent, moments, monitors] = data;
  return (
    <CanWriteProvider value={canWrite}>
      <AgentDetail agent={agent} moments={moments} monitors={monitors} />
    </CanWriteProvider>
  );
}
