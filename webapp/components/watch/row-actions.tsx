"use client";

import * as React from "react";
import {
  Bell, BellRing, Bookmark, Folder, FolderMinus, RotateCcw, Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useCanWrite } from "@/lib/auth/can-write";
import type { UserState } from "@/lib/types";

/**
 * Per-story action row.
 *
 *   variant="watch"   — Save · Folder · Ignore.
 *   variant="library" — Save · Folder. No Ignore (the user explicitly
 *                       saved this story, ignoring it would conflict).
 *   variant="folder"  — Save · Folder · Remove-from-current-folder. No
 *                       Ignore (a folder is a curated set — leaving it
 *                       is the explicit symmetric action).
 *
 * Save and Folder are fully independent — picking a folder does not
 * auto-save the story, and unsaving does not remove it from any folder.
 * Same model as Gmail's Star / Labels or Feedly's Read Later / Boards.
 *
 * Pure presentation: the parent owns the optimistic state and API
 * calls. When `state === null` (non-owner / anon), buttons render
 * disabled with a sign-in tooltip.
 *
 * ## Demo accounts
 *
 * A read-only account keeps every button visible, greyed, with the action
 * name and why it is unavailable. Hiding them would be tidier and worse:
 * the visitor would never learn the feature exists, and discovering it is
 * the point of a demo.
 *
 * Ignore is the exception and stays live, because the API allows it. The
 * line the backend draws is between *triaging* the feed in front of you —
 * read, not interested — and *building* something you expect to find
 * again. This row has to draw the same one, or a button lies.
 */
export function RowActions({
  storyId,
  state,
  variant = "watch",
  onSave,
  onUnsave,
  onFollow,
  onUnfollow,
  onIgnored,
  onUnignored,
  onOpenFolders,
  onRemoveFromFolder,
  viewIgnored = false,
}: {
  storyId: number;
  state: UserState | null | undefined;
  variant?: "watch" | "library" | "folder";
  onSave?: (storyId: number) => void;
  onUnsave?: (storyId: number) => void;
  onFollow?: (storyId: number) => void;
  onUnfollow?: (storyId: number) => void;
  onIgnored?: (storyId: number) => void;
  onUnignored?: (storyId: number) => void;
  /** Opens the FolderPickerDialog for this story. The parent owns the
   *  dialog state since membership reads/writes flow through `state`. */
  onOpenFolders?: (storyId: number) => void;
  /** Folder-context only: detach this story from the folder currently
   *  being viewed. The parent binds the active folderId. */
  onRemoveFromFolder?: (storyId: number) => void;
  /** When true, the trash button becomes a restore button (un-ignore). */
  viewIgnored?: boolean;
}) {
  const t = useTranslations("actions");
  const tUm = useTranslations("userMenu");
  const canWrite = useCanWrite();
  const isOwner = state !== null && state !== undefined;
  const saved = state?.saved ?? false;
  const followed = state?.followed ?? false;
  const inAnyFolder = (state?.folder_ids?.length ?? 0) > 0;
  const signInPrompt = tUm("signIn");

  /** Tooltip for an action this account cannot perform: keep the verb, add
   *  the reason. "Save" alone on a dead button explains nothing. */
  const locked = (label: string) => `${label} — ${t("demoOnly")}`;

  /** Reasons a button is inert, in order of precedence: not signed in as
   *  the owner, then not allowed to create things. */
  const gate = (label: string) =>
    !isOwner
      ? { disabled: true, title: signInPrompt }
      : !canWrite
        ? { disabled: true, title: locked(label) }
        : { disabled: false, title: label };

  const handleSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOwner || !canWrite) return;
    if (saved) onUnsave?.(storyId);
    else onSave?.(storyId);
  };

  const handleFollow = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOwner || !canWrite) return;
    if (followed) onUnfollow?.(storyId);
    else onFollow?.(storyId);
  };

  const handleIgnore = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOwner) return;
    if (viewIgnored) onUnignored?.(storyId);
    else onIgnored?.(storyId);
  };

  const handleOpenFolders = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOwner || !canWrite) return;
    onOpenFolders?.(storyId);
  };

  const handleRemoveFromFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isOwner || !canWrite) return;
    onRemoveFromFolder?.(storyId);
  };

  const showFolderPicker =
    (variant === "watch" || variant === "library" || variant === "folder") &&
    !!onOpenFolders;

  return (
    <div
      className="flex items-center gap-0.5"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <ActionBtn
        {...gate(saved ? t("unsave") : t("save"))}
        active={saved}
        onClick={handleSave}
      >
        <Bookmark
          size={12}
          strokeWidth={1.6}
          fill={saved ? "currentColor" : "none"}
        />
      </ActionBtn>

      {/* Follow / unfollow — subscribes to per-story notifications.
       *  Hidden in non-watch contexts (Library / Folder views) because
       *  the user already manages these stories through other affordances
       *  there; adding a fourth button felt cluttery. They can still
       *  follow/unfollow from the Watch list once the story is back.
       *
       *  Tone = "info" (blue accent) when active, distinct from
       *  bookmark/folder's yellow so the user reads the row's state
       *  at a glance: yellow = saved/organized, blue = notify-me. */}
      {variant === "watch" && (onFollow || onUnfollow) && (
        <ActionBtn
          {...gate(followed ? t("unfollow") : t("follow"))}
          active={followed}
          activeTone="info"
          onClick={handleFollow}
        >
          {followed ? (
            // BellRing draws the side motion lines that read as "this
            // bell is ringing" — keeps the active state legible at
            // 12px even after we already fill the bell body with the
            // accent color. The lines stay stroked so they remain
            // visible against the filled body.
            <BellRing
              size={12}
              strokeWidth={1.7}
              fill="currentColor"
            />
          ) : (
            <Bell size={12} strokeWidth={1.6} />
          )}
        </ActionBtn>
      )}

      {showFolderPicker && (
        <ActionBtn
          {...gate(t("folders"))}
          active={inAnyFolder}
          onClick={handleOpenFolders}
        >
          <Folder
            size={12}
            strokeWidth={1.6}
            fill={inAnyFolder ? "currentColor" : "none"}
          />
        </ActionBtn>
      )}

      {variant === "watch" && (
        <ActionBtn
          // No gate() here on purpose: ignoring is triage, which the API
          // allows read-only accounts to do (see src/write_access.py).
          title={
            !isOwner
              ? signInPrompt
              : viewIgnored
                ? t("restore")
                : t("ignore")
          }
          disabled={!isOwner}
          onClick={handleIgnore}
        >
          {viewIgnored ? (
            <RotateCcw size={12} strokeWidth={1.6} />
          ) : (
            <Trash2 size={12} strokeWidth={1.6} />
          )}
        </ActionBtn>
      )}

      {variant === "folder" && onRemoveFromFolder && (
        <ActionBtn
          {...gate(t("removeFromFolder"))}
          onClick={handleRemoveFromFolder}
        >
          <FolderMinus size={12} strokeWidth={1.6} />
        </ActionBtn>
      )}
    </div>
  );
}

function ActionBtn({
  title,
  active,
  activeTone = "bookmark",
  disabled,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  /** Color of the icon when `active=true`.
   *   - "bookmark" (default) : yellow/amber, used by Save + Folder
   *   - "info"               : accent blue, used by Follow (Bell) to
   *                            visually separate "I'm tracking this"
   *                            from "I saved/organized this". */
  activeTone?: "bookmark" | "info";
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // `aria-disabled` and not `disabled`. A disabled button receives no
      // mouse events at all, so the browser never shows its `title` — the
      // explanation for why it is inert becomes unreachable, which is the
      // opposite of the point. Marking it this way keeps the tooltip and
      // still tells assistive technology the control is unavailable.
      //
      // Nothing happens on click because every handler returns early when
      // the action is not permitted; the API refuses it too.
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center",
        "h-6 w-6 rounded-md shrink-0",
        "transition-colors",
        active
          ? activeTone === "info"
            ? "text-accent-text"
            : "text-bookmark-text"
          : disabled
            // Plain default cursor, no "forbidden" sign: the greyed icon
            // already says it is unavailable, and the tooltip says why.
            // A slash-through cursor only scolds.
            ? "text-text-4 cursor-default"
            : "text-text-3 hover:text-text hover:bg-bg-hover cursor-pointer",
      )}
    >
      {children}
    </button>
  );
}
