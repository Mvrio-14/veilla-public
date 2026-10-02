import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";

/**
 * Text a model wrote, set apart from the interface around it: a tinted
 * zone, a label with the icon the app uses for the model, and italics.
 * A reason reads like any other sentence on the page otherwise, and the
 * reader should never have to wonder whether the app or the agent is
 * speaking.
 */
export function ModelText({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="rounded-md bg-bg-sub px-3 py-2">
      <figcaption className="flex items-center gap-1.5 text-[10.5px] font-medium text-text-4">
        <Sparkles size={11} strokeWidth={1.8} aria-hidden />
        {label}
      </figcaption>
      <div className="mt-1 text-[12.5px] leading-relaxed italic text-text-2">{children}</div>
    </figure>
  );
}
