import type { ReactNode } from "react";

/**
 * The two blocks a detail page is made of: a figure worth reading at a
 * glance, and a labelled fact in a list.
 */

export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-bg-elev px-4 py-3.5">
      <span className="block text-[11.5px] text-text-3">{label}</span>
      <b className="block mt-1 text-[24px] font-normal tracking-[-0.02em]">{value}</b>
      {note && <span className="block mt-1 text-[11.5px] text-text-4">{note}</span>}
    </div>
  );
}

/** A list of `Fact`s. */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="rounded-lg border border-border bg-bg-elev divide-y divide-border">
      {children}
    </dl>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <dt className="w-[170px] shrink-0 text-[12px] text-text-3">{label}</dt>
      <dd className="min-w-0 text-[12.5px] text-text break-words">{children}</dd>
    </div>
  );
}
