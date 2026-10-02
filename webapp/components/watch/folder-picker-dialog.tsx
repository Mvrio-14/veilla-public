"use client";

import * as React from "react";
import { Check, Folder as FolderIcon, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Folder } from "@/lib/types";

/**
 * Multi-select dialog opened from RowActions to file a story into one
 * or more manual folders.
 *
 * Batch / commit-at-Save model — coherent with the other dialogs
 * (FolderEditDialog, ViewEditDialog). Toggling a checkbox stages the
 * change in a local `draft` set; clicking Save diffs draft against the
 * initial selection and fires `onAdd` / `onRemove` for the actual
 * deltas. Cancel (or clicking outside / pressing Esc) discards the
 * draft, leaving membership untouched.
 *
 * Inline "+ New folder" stays semi-immediate: it creates the folder
 * server-side (so it can show up in the picker and be checked) but
 * does NOT file the story — that piece is folded into the same
 * commit, fired by Save. Net effect: cancelling after creating leaves
 * an empty folder around, identical to the sidebar's "+ New" flow.
 */
function FolderPickerDialogBody({
  // `open` stays in the type below — the shell reads it to decide
  // whether to mount this body at all — but the body itself never has
  // to ask: if it is running, the dialog is open.
  onOpenChange,
  folders,
  selectedFolderIds,
  onAdd,
  onRemove,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folders: Folder[];
  /** Current server-side membership — drives the dialog's initial draft. */
  selectedFolderIds: string[];
  onAdd: (folderId: string) => void | Promise<void>;
  onRemove: (folderId: string) => void | Promise<void>;
  /** Creates a new folder server-side and returns it. The picker pushes
   *  the new folder.id into the local draft (auto-checked) but does
   *  NOT file the story — that happens at Save commit via `onAdd`. */
  onCreate: (name: string) => Promise<Folder>;
}) {
  const t = useTranslations("folderPicker");
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  /** Draft membership — local-only until Save commits the diff.
   *  `initialIds` is the snapshot taken when the dialog opened; the
   *  diff at commit time is (draft \\ initial) → adds, (initial \\
   *  draft) → removes. */
  // Both snapshots are taken once, when this body mounts — which is the
  // moment the dialog opens. Deliberately not re-taken afterwards: a
  // /watch refetch arriving mid-edit must not stomp pending changes,
  // which is why `selectedFolderIds` is read in the initialiser and
  // never watched.
  const [draftIds, setDraftIds] = React.useState<Set<string>>(
    () => new Set(selectedFolderIds),
  );
  const [initialIds] = React.useState<Set<string>>(
    () => new Set(selectedFolderIds),
  );

  const toggleDraft = (folderId: string) => {
    setDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  const renderFolderRow = (f: Folder) => {
    const checked = draftIds.has(f.id);
    return (
      <button
        key={f.id}
        type="button"
        onClick={() => toggleDraft(f.id)}
        className={cn(
          "flex items-center gap-2.5 px-4 py-2",
          "text-[13px] text-left cursor-pointer",
          "transition-colors duration-100",
          "hover:bg-bg-hover",
        )}
      >
        <span
          className={cn(
            "shrink-0 inline-flex items-center justify-center",
            "w-4 h-4 rounded border",
            checked
              ? "bg-text border-text text-bg"
              : "border-border bg-bg-elev",
          )}
        >
          {checked && <Check size={11} strokeWidth={2.4} />}
        </span>
        <FolderIcon
          size={12}
          strokeWidth={1.7}
          className="shrink-0 text-text-3"
        />
        <span
          className={cn(
            "flex-1 truncate",
            checked ? "text-text font-medium" : "text-text-2",
          )}
        >
          {f.name}
        </span>
        {f.story_count > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-text-4">
            {f.story_count}
          </span>
        )}
      </button>
    );
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (trimmed.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      const created = await onCreate(trimmed);
      // Auto-check the new folder in the draft so the user doesn't
      // have to find it in the list afterwards.
      setDraftIds((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
      setCreating(false);
      setNewName("");
    } catch (err) {
      console.error("inline folder create failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = async () => {
    if (submitting) return;
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const id of draftIds) {
      if (!initialIds.has(id)) toAdd.push(id);
    }
    for (const id of initialIds) {
      if (!draftIds.has(id)) toRemove.push(id);
    }
    if (toAdd.length === 0 && toRemove.length === 0) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    try {
      await Promise.all([
        ...toAdd.map((id) => onAdd(id)),
        ...toRemove.map((id) => onRemove(id)),
      ]);
      onOpenChange(false);
    } catch (err) {
      console.error("folder picker commit failed", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
        <DialogHeader className="px-4 py-3 border-b border-border space-y-0">
          <DialogTitle className="text-[14px] font-semibold tracking-[-0.01em] text-text">
            {t("title")}
          </DialogTitle>
        </DialogHeader>

        <div className="max-h-[min(60vh,420px)] overflow-y-auto py-1.5">
          {folders.length === 0 && !creating ? (
            <div className="px-4 py-3 text-[12px] text-text-3 italic">
              {t("empty")}
            </div>
          ) : (
            <div className="flex flex-col">
              {folders.map(renderFolderRow)}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-2.5">
          {creating ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    else if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  placeholder={t("createPlaceholder")}
                  autoFocus
                  maxLength={120}
                  className="
                    flex-1 px-2 py-1.5 rounded-md
                    bg-bg-sub border border-border
                    text-[13px] text-text placeholder:text-text-4
                    outline-none focus:border-text-4 focus:bg-bg-elev
                    transition-colors
                  "
                />
                <button
                  type="button"
                  onClick={() => {
                    setCreating(false);
                    setNewName("");
                  }}
                  className="
                    text-[12px] font-medium px-2.5 py-1.5 rounded-md
                    text-text-2 hover:bg-bg-hover hover:text-text
                    cursor-pointer transition-colors
                  "
                >
                  {t("createCancel")}
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={newName.trim().length === 0 || submitting}
                  className={cn(
                    "text-[12px] font-semibold px-2.5 py-1.5 rounded-md",
                    "transition-colors",
                    newName.trim().length === 0 || submitting
                      ? "bg-bg-sub text-text-4 cursor-not-allowed"
                      : "bg-text text-bg hover:bg-text-2 cursor-pointer",
                  )}
                >
                  {t("createConfirm")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="
                w-full flex items-center gap-2 px-2 py-1.5 rounded-md
                text-[12.5px] font-medium text-text-2
                hover:bg-bg-hover hover:text-text
                cursor-pointer transition-colors
              "
            >
              <Plus size={12} strokeWidth={1.7} />
              <span>{t("createInline")}</span>
            </button>
          )}
        </div>

        <DialogFooter className="px-4 py-3 border-t border-border flex flex-row items-center gap-2 sm:gap-2 sm:justify-end">
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
            onClick={handleSave}
            disabled={submitting}
            className={cn(
              "text-[12px] font-semibold px-3 py-1.5 rounded-md",
              "transition-colors",
              submitting
                ? "bg-bg-sub text-text-4 cursor-not-allowed"
                : "bg-text text-bg hover:bg-text-2 cursor-pointer",
            )}
          >
            {t("save")}
          </button>
        </DialogFooter>
    </>
  );
}


/**
 * Dialog shell. The body is mounted only while open, so every opening
 * starts from the folders currently on the story and every closing
 * throws away whatever was half-typed — with no reset code to keep in
 * step with the fields.
 */
export function FolderPickerDialog(
  props: React.ComponentProps<typeof FolderPickerDialogBody>,
) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="!max-w-[420px] w-[min(420px,calc(100vw-32px))] flex flex-col gap-0 p-0"
        showCloseButton={false}
      >
        {props.open && <FolderPickerDialogBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}
