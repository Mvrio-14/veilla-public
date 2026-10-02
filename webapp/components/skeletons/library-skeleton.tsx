import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton } from "./card-skeleton";

/**
 * /library loading state — single-column layout (no contextual
 * sidebar). Mirrors `<SavedView />`'s header bar + grouped card list.
 */
export function LibrarySkeleton() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Sub-header + filter bar */}
      <div className="border-b border-border bg-bg shrink-0">
        <div className="max-w-[880px] mx-auto px-3 pt-3 pb-2 flex items-center gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="max-w-[880px] mx-auto px-3 pb-3 flex items-center gap-2">
          <Skeleton className="h-7 w-32 rounded-md" />
          <Skeleton className="h-7 w-32 rounded-md" />
          <div className="flex-1" />
          <Skeleton className="h-6 w-20 rounded-md" />
          <Skeleton className="h-7 w-44 rounded-md" />
          <Skeleton className="h-7 w-20 rounded-md" />
        </div>
      </div>

      {/* Grouped cards */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-[880px] mx-auto px-3 pt-3 pb-12 flex flex-col gap-5">
          {Array.from({ length: 2 }).map((_, groupIdx) => (
            <div key={groupIdx} className="flex flex-col gap-2">
              {/* Section header */}
              <div className="sticky top-0 z-10 -mx-3 px-3 py-1.5 bg-bg/95 backdrop-blur-sm">
                <Skeleton className="h-3 w-32" />
              </div>
              {Array.from({ length: 4 }).map((_, cardIdx) => (
                <CardSkeleton key={cardIdx} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
