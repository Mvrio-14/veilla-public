import { Suspense } from "react";
import { notFound } from "next/navigation";
import { MonitorDetail } from "@/components/monitors/monitor-detail";
import { Loader } from "@/components/ui/loader";
import { fetchMonitor } from "@/lib/api";
import { loadForPage } from "@/lib/auth/page-data";

/** One monitor the reader follows: health, configuration, fetch log. */
export default async function MonitorPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  return (
    <Suspense fallback={<Loader />}>
      <MonitorContent id={id} />
    </Suspense>
  );
}

async function MonitorContent({ id }: { id: number }) {
  const { data } = await loadForPage(`/monitors/${id}`, (token) => fetchMonitor(id, token));
  return <MonitorDetail monitor={data.monitor} runs={data.runs} items={data.items} />;
}
