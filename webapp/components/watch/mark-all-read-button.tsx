"use client";

import * as React from "react";
import { CheckCheck } from "lucide-react";
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

/**
 * "Tout marquer comme lu" — the Watch fresh-start button. Marks every
 * story currently loaded in the watch as read, regardless of the active
 * filter/scope (see watch-main's handleMarkAllRead). Gated behind a
 * confirmation dialog so a stray click can't wipe someone's unread state.
 *
 * Disabled when there's nothing unread, so it never looks actionable when
 * it would be a no-op.
 */
export function MarkAllReadButton({
  unreadCount,
  onConfirm,
}: {
  unreadCount: number;
  onConfirm: () => void;
}) {
  const t = useTranslations("list");
  const [open, setOpen] = React.useState(false);
  const disabled = unreadCount === 0;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={t("markAll.tooltip")}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md",
          "border text-[12px] font-medium",
          "transition-colors duration-100",
          disabled
            ? "bg-bg-elev text-text-4 border-border cursor-not-allowed"
            : "bg-bg-elev text-text-2 border-border hover:bg-bg-hover hover:text-text cursor-pointer",
        )}
      >
        <CheckCheck size={12} strokeWidth={1.7} />
        <span>{t("markAll.button")}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="!max-w-[440px] w-[min(440px,calc(100vw-32px))] flex flex-col gap-0 p-0">
          <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
            <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
              {t("markAll.confirmTitle")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
              {t("markAll.confirmBody", { count: unreadCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-2 sm:gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="
                text-[12px] font-medium px-3 py-1.5 rounded-md
                text-text-2 hover:bg-bg-hover hover:text-text
                cursor-pointer transition-colors
              "
            >
              {t("markAll.cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
              className="
                text-[12px] font-semibold px-3 py-1.5 rounded-md
                bg-text text-bg hover:bg-text-2
                cursor-pointer transition-colors
              "
            >
              {t("markAll.confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
