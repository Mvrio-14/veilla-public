import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Status badge next to story titles.
 *   <TitleFlag kind="new"/>          → small filled blue dot
 *   <TitleFlag kind="updated">+3</…> → blue pill with count
 */
const titleFlagStyles = cva(
  "inline-flex items-center justify-center align-middle shrink-0 mr-[7px] -translate-y-px",
  {
    variants: {
      kind: {
        new: "w-2 h-2 rounded-full bg-new shadow-[0_0_0_2px_color-mix(in_oklch,var(--new)_18%,transparent)]",
        updated:
          "h-4 min-w-[22px] px-[5px] rounded-lg bg-new text-white text-[10px] font-bold leading-none tabular-nums shadow-[0_0_0_2px_color-mix(in_oklch,var(--new)_18%,transparent)]",
      },
    },
  },
);

export type TitleFlagProps = VariantProps<typeof titleFlagStyles> & {
  children?: React.ReactNode;
  className?: string;
};

export function TitleFlag({ kind, children, className }: TitleFlagProps) {
  return (
    <span className={cn(titleFlagStyles({ kind }), className)}>
      {children}
    </span>
  );
}
