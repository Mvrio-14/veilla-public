import { Skeleton } from "@/components/ui/skeleton";

/**
 * Cluster-card-shaped placeholder. Reserves the same visual footprint
 * as a real `<ClusterCard />` so the layout doesn't shift when stories
 * arrive: meta row + 2-line title + small footer row.
 *
 * Used by per-page loading skeletons. Not interactive.
 */
export function CardSkeleton() {
  return (
    <div className="px-3 py-3 border border-border rounded-lg bg-bg-elev/40 flex flex-col gap-2.5">
      {/* Meta row: source chip + categories + time */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-14" />
        <div className="flex-1" />
        <Skeleton className="h-3 w-10" />
      </div>
      {/* Title — 2 lines */}
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-[78%]" />
      </div>
      {/* Footer: source count + actions */}
      <div className="flex items-center gap-2 pt-0.5">
        <Skeleton className="h-2.5 w-16" />
        <div className="flex-1" />
        <Skeleton className="h-3 w-3 rounded-md" />
        <Skeleton className="h-3 w-3 rounded-md" />
        <Skeleton className="h-3 w-3 rounded-md" />
      </div>
    </div>
  );
}
