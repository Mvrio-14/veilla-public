/**
 * Tiny lang tag (FR/EN/ZH…) shown inline next to titles.
 * Pure Tailwind. No CVA — single visual variant.
 */
export function Lang({ code }: { code: string }) {
  return (
    <span
      className="
        inline-flex items-center justify-center
        font-mono uppercase tracking-[0.02em]
        text-[9px] font-semibold text-text-3
        bg-bg-sub border border-border
        rounded-[3px]
        px-1 py-px leading-[1.2]
      "
    >
      {(code || "").toUpperCase()}
    </span>
  );
}
