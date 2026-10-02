import { Suspense } from "react";
import { DecisionsView } from "@/components/signal/decisions-view";
import { Loader } from "@/components/ui/loader";
import { fetchDecisions, fetchWatchers } from "@/lib/api";
import { loadForPage } from "@/lib/auth/page-data";

/** Decisions: every story the agents looked at this week. */
export default function DecisionsPage() {
  return (
    <Suspense fallback={<Loader />}>
      <DecisionsContent />
    </Suspense>
  );
}

async function DecisionsContent() {
  const { data } = await loadForPage("/signal/decisions", (token) =>
    Promise.all([fetchDecisions(token), fetchWatchers(token)]),
  );
  const [moments, agents] = data;
  return <DecisionsView moments={moments} agents={agents} />;
}
