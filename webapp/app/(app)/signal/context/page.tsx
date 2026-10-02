import { Suspense } from "react";
import { ContextView } from "@/components/signal/context-view";
import { Loader } from "@/components/ui/loader";
import { fetchContext } from "@/lib/api";
import { CanWriteProvider } from "@/lib/auth/can-write";
import { loadForPage } from "@/lib/auth/page-data";

/** The reader's context, shared by all their agents. */
export default function ContextPage() {
  return (
    <Suspense fallback={<Loader />}>
      <ContextContent />
    </Suspense>
  );
}

async function ContextContent() {
  const { data, canWrite } = await loadForPage("/signal/context", fetchContext);
  return (
    <CanWriteProvider value={canWrite}>
      <ContextView context={data} />
    </CanWriteProvider>
  );
}
