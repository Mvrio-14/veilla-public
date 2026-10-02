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
import { cn } from "@/lib/utils";
import type { Folder } from "@/lib/types";

/**
 * Dialog for creating / renaming a manual folder.
 *
 * Folders are just a name + a membership junction — there's no criteria
 * to define here (that's `<ViewEditDialog />`'s job for saved views).
 *
 * In edit mode (`mode="edit"`), surfaces a Delete button that opens an
 * inline confirmation pane inside the same Dialog: clicking Delete
 * swaps the body to a "really delete?" prompt rather than chaining a
 * second AlertDialog. Keeps the destructive action visible without
 * dropping a separate dialog on top of this one.
 */
function FolderEditDialogBody({
  onOpenChange,
  mode,
  initialFolder,
  onSubmit,
  onDelete,
}: {
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  initialFolder?: Folder;
  /** Receives the trimmed name. Throws Response on HTTP error so the
   *  dialog can read `.status` and surface a 409 as "name taken". */
  onSubmit: (name: string) => Promise<void>;
  /** Required when mode="edit". Throw on failure — same shape as onSubmit. */
  onDelete?: (folderId: string) => Promise<void>;
}) {
  const t = useTranslations("folderDialog");
  // Every field is seeded at mount, which is the moment the dialog
  // opens. Nothing is re-seeded afterwards and nothing is cleared on
  // close, because the body does not outlive the dialog.
  const [name, setName] = React.useState<string>(initialFolder?.name ?? "");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const trimmed = name.trim();
  const nameUnchanged =
    mode === "edit" && trimmed === (initialFolder?.name ?? "").trim();
  const canSubmit = trimmed.length > 0 && !submitting;
  const showSaveButton = mode === "create" || !nameUnchanged;

  const handleSubmit = React.useCallback(async () => {
    if (!canSubmit) return;
    if (mode === "edit" && nameUnchanged) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (err: unknown) {
      // Backend surfaces "name already taken" as 409.
      if (err instanceof Response && err.status === 409) {
        setError(t("nameTaken"));
      } else {
        console.error("folder save failed", err);
        setError(t("nameTaken")); // fallback to a friendly message
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit, mode, nameUnchanged, trimmed, onSubmit, onOpenChange, t,
  ]);

  const handleDelete = React.useCallback(async () => {
    if (mode !== "edit" || !initialFolder || !onDelete) return;
    setSubmitting(true);
    try {
      await onDelete(initialFolder.id);
      onOpenChange(false);
    } catch (err) {
      console.error("folder delete failed", err);
    } finally {
      setSubmitting(false);
      setConfirmDelete(false);
    }
  }, [mode, initialFolder, onDelete, onOpenChange]);

  return (
    <>
        {confirmDelete && mode === "edit" && initialFolder ? (
          <>
            <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
              <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
                {t("deleteConfirmTitle", { name: initialFolder.name })}
              </DialogTitle>
              <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
                {t("deleteConfirmBody", { count: initialFolder.story_count })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-2 sm:gap-2 sm:justify-end">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="
                  text-[12px] font-medium px-3 py-1.5 rounded-md
                  text-text-2 hover:bg-bg-hover hover:text-text
                  cursor-pointer transition-colors
                "
              >
                {t("deleteConfirmCancel")}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={submitting}
                className={cn(
                  "text-[12px] font-semibold px-3 py-1.5 rounded-md",
                  "transition-colors",
                  submitting
                    ? "bg-bg-sub text-text-4 cursor-not-allowed"
                    : "bg-hot text-bg hover:brightness-110 cursor-pointer",
                )}
              >
                {t("deleteConfirmConfirm")}
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
              <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
                {mode === "create" ? t("createTitle") : t("editTitle")}
              </DialogTitle>
              <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
                {t("description")}
              </DialogDescription>
            </DialogHeader>

            <div className="px-5 py-4 space-y-3">
              <div>
                <label
                  htmlFor="folder-name"
                  className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3 mb-2"
                >
                  {t("nameLabel")}
                </label>
                <input
                  id="folder-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (error) setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) handleSubmit();
                  }}
                  placeholder={t("namePlaceholder")}
                  autoFocus
                  maxLength={120}
                  className={cn(
                    "w-full px-3 py-2 rounded-md",
                    "bg-bg-sub border text-[13px] text-text placeholder:text-text-4",
                    "outline-none transition-colors",
                    error
                      ? "border-hot focus:border-hot"
                      : "border-border focus:border-text-4 focus:bg-bg-elev",
                  )}
                />
                {error && (
                  <div className="mt-1.5 text-[11.5px] text-hot">{error}</div>
                )}
              </div>
            </div>

            <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-3 sm:gap-3 sm:justify-between sm:flex-row">
              {mode === "edit" && onDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
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
                {showSaveButton && (
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
                )}
              </div>
            </DialogFooter>
          </>
        )}
    </>
  );
}


/**
 * Dialog shell. The body mounts only while open, so a folder opened for
 * editing is always read fresh — including the delete confirmation,
 * which would otherwise greet the next opening already armed.
 */
export function FolderEditDialog(
  props: React.ComponentProps<typeof FolderEditDialogBody> & { open: boolean },
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="!max-w-[480px] w-[min(480px,calc(100vw-32px))] flex flex-col gap-0 p-0">
        {props.open && <FolderEditDialogBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}
