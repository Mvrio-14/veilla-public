"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A block of prose the user owns, edited and saved explicitly — the
 * reading context, an agent's request: a paragraph a person wrote and a
 * model will read.
 *
 * **Never lose input.** A failed save keeps the draft on screen, and
 * `beforeunload` catches the tab closing on unsaved text.
 *
 * **Saving is explicit.** No autosave: the next judgments follow the new
 * text, which should not happen because someone paused while typing.
 * `versionNote` is where the caller says what saving changes, next to
 * the button, before the click.
 *
 * After a save the parent re-renders with the server's copy. The draft
 * is re-seeded by comparing the incoming value with the last one seen,
 * during render rather than in an effect, so the box never shows a stale
 * paragraph for a frame.
 */
export function ProseEditor({
  value,
  onSave,
  label,
  hint,
  versionNote,
  placeholder,
  rows = 14,
  readOnly = false,
}: {
  value: string;
  onSave: (next: string) => Promise<unknown>;
  label: string;
  hint?: string;
  /** What an edit costs — shown next to the button while dirty. */
  versionNote?: string;
  placeholder?: string;
  rows?: number;
  /** For an account that may read but not write: no editing, no button. */
  readOnly?: boolean;
}) {
  const t = useTranslations("prose");

  const [draft, setDraft] = React.useState(value);
  const [saved, setSaved] = React.useState(value);
  const [state, setState] = React.useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );

  // Adjust during render rather than in an effect: after a save the
  // parent re-renders with the server's copy, and a one-frame stale
  // paragraph is worse here than anywhere else.
  const [lastValue, setLastValue] = React.useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setSaved(value);
    // A remote change while the user is mid-edit must not wipe their
    // work — their draft wins, and the mismatch shows as "unsaved".
    if (draft === saved) setDraft(value);
  }

  const dirty = draft !== saved;

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    setState("saving");
    try {
      await onSave(draft);
      setSaved(draft);
      setState("done");
    } catch (err) {
      // The draft stays. Losing it would be the one unforgivable failure
      // of a text box.
      console.error("[prose] save failed", err);
      setState("error");
    }
  };

  return (
    <section>
      <div className="flex items-baseline gap-3">
        <h2 className="text-[13px] font-medium text-text">{label}</h2>
        {dirty && (
          <span className="text-[11.5px] text-text-4">{t("unsaved")}</span>
        )}
      </div>
      {hint && (
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-3">{hint}</p>
      )}

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (state !== "idle") setState("idle");
        }}
        rows={rows}
        placeholder={placeholder}
        readOnly={readOnly}
        spellCheck
        className={cn(
          "mt-3 w-full rounded-lg border bg-bg-sub px-3.5 py-3",
          "text-[13px] leading-relaxed text-text resize-y",
          "outline-none transition-colors",
          "placeholder:text-text-4",
          state === "error"
            ? "border-hot"
            : "border-border focus:border-border-strong",
        )}
      />

      {!readOnly && (
        <div className="flex items-center gap-3 mt-3">
          <Button
            variant="solid"
            size="lg"
            onClick={save}
            disabled={!dirty || state === "saving"}
          >
            {state === "saving" ? t("saving") : t("save")}
          </Button>

          {state === "error" ? (
            <span role="alert" className="text-[12px] text-hot">
              {t("failed")}
            </span>
          ) : state === "done" && !dirty ? (
            <span className="text-[12px] text-good">{t("saved")}</span>
          ) : (
            dirty &&
            versionNote && (
              <span className="text-[12px] text-text-4">{versionNote}</span>
            )
          )}
        </div>
      )}
    </section>
  );
}
