import { Skeleton } from "@/components/ui/skeleton";
import { CardSkeleton } from "./card-skeleton";

/**
 * A folder's loading state — its header and cards. The folder list
 * lives in the app sidebar, which stays on screen while this loads.
 */
export function FoldersSkeleton() {
  return (
    <>
      {/* Center column — folder header + virtualized story list */}
      <div className="flex-1 flex flex-col min-w-0 bg-bg">
        <div className="px-5 pt-4 pb-3 border-b border-border">
          <Skeleton className="h-4 w-48 mb-2" />
          <Skeleton className="h-3 w-24" />
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-[880px] mx-auto px-3 pt-3 pb-12 flex flex-col gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
