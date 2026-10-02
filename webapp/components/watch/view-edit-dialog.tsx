"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FilterPicker } from "./_atoms";
import { BooleanQueryEditor } from "./boolean-editor";
import { cn } from "@/lib/utils";
import { advancedIsActive, emptyAdvanced, normalizeAdvanced, type Advanced } from "@/lib/filter";
import type { Aggregations } from "@/lib/aggregate";
import type { View, WatchUniverse } from "@/lib/types";

/**
 * Dialog for creating / editing a saved view ("Mes vues"). Shares the
 * `<FilterPicker />` form with `<FiltersDialog />` but with three
 * differences:
 *   - a Name input at the top (views are named, applied filters aren't)
 *   - `showCounts={false}` on the picker (counts are misleading for a
 *     forward-looking view definition)
 *   - submit calls onSubmit({ name, criteria }) instead of applying
 *     filters to the current list
 *
 * Edit mode (`mode="edit"`) pre-fills from `initialView`, surfaces a
 * Delete button, and labels the primary action "Enregistrer".
 */
function ViewEditDialogBody({
  onOpenChange,
  mode,
  initialView,
  aggs,
  universe,
  onSubmit,
  onDelete,
}: {
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialView?: View;
  aggs: Aggregations;
  /** Full universe of filterable values — drives the dropdowns for
   *  Categories / Langs / Feeds / Origin so the user can pick values that
   *  aren't currently in the watch. */
  universe?: WatchUniverse;
  onSubmit: (payload: {
    name: string;
    criteria: Advanced;
    /** Lucene Boolean query string, ONLY set when the user composed
     *  the view in Boolean mode. The save endpoint stores it on
     *  `views.criteria_text` and the resolver picks it up at read
     *  time. Null = Panel mode → backend will compose from `criteria`. */
    criteriaText: string | null;
  }) => void;
  onDelete?: (viewId: string) => void;
}) {
  const t = useTranslations("viewDialog");
  const [name, setName] = React.useState<string>(initialView?.name ?? "");
  // normalizeAdvanced protects against older saved views whose criteria
  // JSONB lacks fields added later (e.g. articleTypes). Without it,
  // FilterPicker crashes on `draft.<missing>.length`.
  const [draft, setDraft] = React.useState<Advanced>(
    normalizeAdvanced(initialView?.criteria),
  );
  // Boolean mode state. When `initialView.criteria_text` is non-empty,
  // we open the dialog in Boolean mode by default (= the view was
  // saved as Boolean, the user expects to keep editing it that way).
  const initialBooleanText = (initialView?.criteria_text ?? "").trim();
  const [editorMode, setEditorMode] = React.useState<"panel" | "boolean">(
    initialBooleanText ? "boolean" : "panel",
  );
  const [booleanText, setBooleanText] = React.useState<string>(initialBooleanText);

  const trimmedName = name.trim();
  // Submit gate: Panel mode requires non-empty advanced; Boolean mode
  // requires non-empty text. Name is required in both.
  const canSubmit =
    trimmedName.length > 0 &&
    (editorMode === "panel"
      ? advancedIsActive(draft)
      : booleanText.trim().length > 0);

  const handleSubmit = React.useCallback(() => {
    if (!canSubmit) return;
    onSubmit({
      name:         trimmedName,
      criteria:     editorMode === "panel" ? draft : emptyAdvanced,
      criteriaText: editorMode === "boolean" ? booleanText.trim() : null,
    });
    onOpenChange(false);
  }, [
    canSubmit, trimmedName, draft, booleanText, editorMode,
    onSubmit, onOpenChange,
  ]);

  const handleDelete = React.useCallback(() => {
    if (mode !== "edit" || !initialView || !onDelete) return;
    onDelete(initialView.id);
    onOpenChange(false);
  }, [mode, initialView, onDelete, onOpenChange]);

  return (
    <>
        <DialogHeader className="px-5 py-3.5 border-b border-border space-y-0">
          <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
            {mode === "create" ? t("createTitle") : t("editTitle")}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-text-3">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name */}
          <div>
            <label
              htmlFor="view-name"
              className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3 mb-2"
            >
              {t("nameLabel")}
            </label>
            <input
              id="view-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
              autoFocus
              className="
                w-full px-3 py-2 rounded-md
                bg-bg-sub border border-border
                text-[13px] text-text placeholder:text-text-4
                outline-none focus:border-text-4 focus:bg-bg-elev
                transition-colors
              "
            />
          </div>

          {/* Editor mode toggle. Panel mode is the FilterPicker; Boolean
           *  mode is the Lucene-syntax editor. Saved views written in
           *  Boolean mode persist their criteria_text to the backend;
           *  Panel-mode views save the Advanced JSONB. */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-text-3 uppercase tracking-[0.06em] font-semibold">
              Mode:
            </span>
            <button
              type="button"
              onClick={() => setEditorMode("panel")}
              className={cn(
                "px-2.5 py-1 rounded-md border transition-colors",
                editorMode === "panel"
                  ? "bg-text text-bg border-text"
                  : "bg-bg-sub border-border text-text-2 hover:bg-bg-hover",
              )}
            >
              Panel
            </button>
            <button
              type="button"
              onClick={() => setEditorMode("boolean")}
              className={cn(
                "px-2.5 py-1 rounded-md border transition-colors",
                editorMode === "boolean"
                  ? "bg-text text-bg border-text"
                  : "bg-bg-sub border-border text-text-2 hover:bg-bg-hover",
              )}
            >
              Boolean
            </button>
            <span className="text-text-4 italic">
              {editorMode === "boolean"
                ? "Lucene syntax — @ to insert entities, AND/OR/NOT, field:value"
                : "Guided picker — easier for quick filters"}
            </span>
          </div>

          {editorMode === "panel" ? (
            /* Reused filter form in view mode: persons/orgs/places use
             *  the picker-with-pills variant. Counts hidden — they'd
             *  reflect the current universe, not the view's future
             *  matches. */
            <FilterPicker
              draft={draft}
              setDraft={setDraft}
              aggs={aggs}
              universe={universe}
              mode="view"
            />
          ) : (
            <BooleanQueryEditor
              value={booleanText}
              onChange={setBooleanText}
            />
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-3 sm:gap-3 sm:justify-between sm:flex-row">
          {mode === "edit" && onDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              className="
                inline-flex items-center gap-1.5
                text-[12px] font-medium px-2.5 py-1.5 rounded-md
                text-hot hover:bg-hot-soft
                cursor-pointer transition-colors
              "
            >
              <Trash2 size={12} strokeWidth={1.7} />
              <span>{t("delete")}</span>
            </button>
          ) : (
            <div />
          )}

          <div className="flex-1" />

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="
                text-[12px] font-medium px-3 py-1.5 rounded-md
                text-text-2 hover:bg-bg-hover hover:text-text
                cursor-pointer transition-colors
              "
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                "text-[12px] font-semibold px-3 py-1.5 rounded-md",
                "transition-colors",
                canSubmit
                  ? "bg-text text-bg hover:bg-text-2 cursor-pointer"
                  : "bg-bg-sub text-text-4 cursor-not-allowed",
              )}
            >
              {mode === "create" ? t("create") : t("save")}
            </button>
          </div>
        </DialogFooter>
    </>
  );
}


/**
 * Dialog shell. The body mounts only while open, so every opening reads
 * the view being edited afresh — a create-then-edit-the-same-view
 * sequence cannot leak stale fields, because there is no surviving
 * state to leak.
 */
export function ViewEditDialog(
  props: React.ComponentProps<typeof ViewEditDialogBody> & { open: boolean },
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="!max-w-[1100px] w-[min(1100px,calc(100vw-64px))] max-h-[calc(100vh-64px)] flex flex-col gap-0 p-0 sm:rounded-xl">
        {props.open && <ViewEditDialogBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}
