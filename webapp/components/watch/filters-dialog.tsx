"use client";

import * as React from "react";
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
import { cn } from "@/lib/utils";
import {
  advancedIsActive,
  countAdvanced,
  emptyAdvanced,
  type Advanced,
} from "@/lib/filter";
import type { Aggregations } from "@/lib/aggregate";

/**
 * Modal for ad-hoc advanced filters. Form lives in `<FilterPicker />` —
 * this component owns the dialog shell, the draft state, and the
 * Clear / Restore prefs / Cancel / Apply footer. Submitting calls
 * `onApply(draft)`.
 *
 * Footer actions:
 *   - "Tout effacer" : wipes the draft (= no filters at all, even
 *     overrides the user's persistent preferences). Used when the
 *     user wants a fresh look at everything.
 *   - "Mes préférences" : restores the user's persistent default
 *     filters (= the shape saved in /settings/preferences). Shown only
 *     when the user has non-empty prefs AND the draft has diverged
 *     from them — otherwise the button is meaningless.
 *
 * For saved-view definition, see `<ViewEditDialog />` which wraps the same
 * `<FilterPicker />` differently.
 */
export function FiltersDialog({
  open,
  onOpenChange,
  advanced,
  userPrefs,
  aggs,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  advanced: Advanced;
  /** User's persistent default filters. When provided + non-empty,
   *  enables the "Mes préférences" restore button. */
  userPrefs?: Advanced;
  aggs: Aggregations;
  onApply: (next: Advanced) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[1100px] w-[min(1100px,calc(100vw-64px))] max-h-[calc(100vh-64px)] flex flex-col gap-0 p-0 sm:rounded-xl">
        {/* The body exists only while the dialog is open, so its draft is
         *  born from the filters in force and dies with the dialog.
         *
         *  The alternative — keeping it mounted and re-seeding it from an
         *  effect when `open` flips — is what this replaced. It worked,
         *  but it made correctness depend on remembering to reset every
         *  new field someone adds to the form. Here there is nothing to
         *  reset: a field that does not exist yet cannot be stale. */}
        {open && (
          <FiltersDialogBody
            advanced={advanced}
            userPrefs={userPrefs}
            aggs={aggs}
            onApply={onApply}
            onOpenChange={onOpenChange}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}


function FiltersDialogBody({
  advanced,
  userPrefs,
  aggs,
  onApply,
  onOpenChange,
}: {
  advanced: Advanced;
  userPrefs?: Advanced;
  aggs: Aggregations;
  onApply: (next: Advanced) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("filtersDialog");

  // Seeded once, at mount — which is the moment the dialog opens.
  const [draft, setDraft] = React.useState<Advanced>(advanced);

  const clear = React.useCallback(() => {
    // Preserve the search bar query — the dialog doesn't own that input.
    setDraft({ ...emptyAdvanced, query: advanced.query });
  }, [advanced.query]);

  const restorePrefs = React.useCallback(() => {
    if (!userPrefs) return;
    // Same query-preservation rule as Clear — search bar lives outside
    // the dialog and shouldn't get wiped when restoring the baseline.
    setDraft({ ...userPrefs, query: advanced.query });
  }, [userPrefs, advanced.query]);

  const apply = React.useCallback(() => {
    onApply(draft);
    onOpenChange(false);
  }, [draft, onApply, onOpenChange]);

  const draftActive = advancedIsActive(draft);
  const advancedCount = countAdvanced(draft);

  /** Are the user's prefs effectively empty? If so we hide the restore
   *  button entirely — restoring to "nothing" is identical to Clear,
   *  and showing two buttons that do the same thing is just noise. */
  const hasPrefs = userPrefs !== undefined && advancedIsActive(userPrefs);

  /** Has the draft already matched the prefs? Then restore is a no-op.
   *  We grey the button rather than hide it (so the affordance stays
   *  visible, just inactive — clearer than it disappearing). */
  const draftMatchesPrefs = React.useMemo(() => {
    if (!userPrefs) return false;
    return JSON.stringify(draft) === JSON.stringify({ ...userPrefs, query: draft.query });
  }, [draft, userPrefs]);

  return (
    <>
        <DialogHeader className="px-5 py-3.5 border-b border-border space-y-0">
          <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-[12px] text-text-3">
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <FilterPicker draft={draft} setDraft={setDraft} aggs={aggs} />
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-3 sm:gap-3 sm:justify-between sm:flex-row">
          <div className="flex items-center gap-1">
            {hasPrefs && (
              <button
                type="button"
                onClick={restorePrefs}
                disabled={draftMatchesPrefs}
                className={cn(
                  "text-[12px] font-medium px-2.5 py-1.5 rounded-md",
                  "transition-colors",
                  draftMatchesPrefs
                    ? "text-text-4 cursor-not-allowed"
                    : "text-accent-text hover:bg-bg-hover cursor-pointer",
                )}
                title={t("restorePrefsHint")}
              >
                {t("restorePrefs")}
              </button>
            )}
            <button
              type="button"
              onClick={clear}
              disabled={!draftActive}
              className={cn(
                "text-[12px] font-medium px-2.5 py-1.5 rounded-md",
                "transition-colors",
                draftActive
                  ? "text-text-2 hover:bg-bg-hover hover:text-text cursor-pointer"
                  : "text-text-4 cursor-not-allowed",
              )}
            >
              {t("clearAll")}
            </button>
          </div>

          <div className="flex-1 text-center text-[11px] text-text-3">
            {advancedCount === 0
              ? t("noAdvancedFilter")
              : t("advancedFilterCount", { count: advancedCount })}
          </div>

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
              onClick={apply}
              className="
                text-[12px] font-semibold px-3 py-1.5 rounded-md
                bg-text text-bg
                hover:bg-text-2
                cursor-pointer transition-colors
              "
            >
              {t("apply")}
            </button>
          </div>
        </DialogFooter>
    </>
  );
}
