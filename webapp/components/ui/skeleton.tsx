import { cn } from "@/lib/utils";

/**
 * Visual placeholder for content that's loading — the standard shadcn
 * pattern: a `bg-bg-elev` block with a subtle pulse animation. Compose
 * page-specific skeletons by stacking these in the same layout shape
 * as the eventual content so the structure doesn't shift when data
 * arrives.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "skeleton-shimmer rounded-md",
        className,
      )}
      {...props}
    />
  );
}
