import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton } from "./card-skeleton";

/**
 * Watch loading state — the main feed column. The Watch's navigation
 * lives in the app sidebar, which stays on screen while this loads, and
 * the detail panel is closed by default, so neither has a placeholder.
 */
export function WatchSkeleton() {
  return (
    <>
      {/* Main column — sticky header + feed */}
      <section className="flex-1 min-w-0 flex flex-col overflow-hidden bg-bg border-r border-border">
        {/* Sticky sub-header */}
        <div className="sticky top-0 z-10 bg-bg border-b border-border">
          <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3 w-8" />
            <div className="flex-1" />
            <Skeleton className="h-6 w-20 rounded-md" />
            <Skeleton className="h-6 w-20 rounded-md" />
          </div>
          {/* Tabs */}
          <div className="flex items-center gap-1 px-3.5 pb-1.5">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
          </div>
        </div>

        {/* Card list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-[880px] mx-auto px-3 pt-3 pb-12 flex flex-col gap-2.5">
            {Array.from({ length: 8 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
