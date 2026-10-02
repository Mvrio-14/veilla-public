"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

/**
 * Sales contact modal — minimal form (name + email + message), POSTs to
 * /api/demo-request which forwards via Resend to the operator. Three
 * states surfaced inline (idle / submitting / success+thanks / error).
 * Reuses the existing Dialog primitive for visual consistency with the
 * rest of the app's destructive-confirm dialogs.
 *
 * ## Why this does not live under components/landing
 *
 * It is mounted twice, and the second place is the account menu inside
 * the app. That is the higher-intent of the two: someone on the open demo
 * who has just found a control they cannot use is further along than a
 * visitor reading the marketing copy. A component reachable from both
 * cannot be named after one of them.
 */
export function ContactModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const t = useTranslations("contact");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [status, setStatus] = React.useState<Status>({ kind: "idle" });

  /** Reset on the way out, so a second open starts fresh.
   *
   *  Done here rather than in an effect watching `open`: an effect would
   *  re-render every close a second time to apply state the user is no
   *  longer looking at, and it reads as if closing and clearing were two
   *  separate facts that happen to coincide. They are one event. Every
   *  path that closes this dialog — the overlay, Escape, both Cancel
   *  buttons — goes through here. */
  const close = React.useCallback(
    (next: boolean) => {
      if (!next) {
        setName("");
        setEmail("");
        setMessage("");
        setStatus({ kind: "idle" });
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (status.kind === "submitting") return;
    setStatus({ kind: "submitting" });
    try {
      const res = await fetch("/api/demo-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });
      if (res.status === 429) {
        setStatus({ kind: "error", message: t("rateLimited") });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: "error", message: t("errorBody") });
        return;
      }
      setStatus({ kind: "success" });
    } catch {
      setStatus({ kind: "error", message: t("errorBody") });
    }
  };

  const submitting = status.kind === "submitting";
  const success = status.kind === "success";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="!max-w-[480px] w-[min(480px,calc(100vw-32px))] flex flex-col gap-0 p-0">
        <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
          <DialogTitle className="text-[16px] font-semibold tracking-[-0.01em] text-text">
            {success ? t("successTitle") : t("title")}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
            {success ? t("successBody") : t("subtitle")}
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="px-5 py-5 flex justify-end">
            <button
              type="button"
              onClick={() => close(false)}
              className="
                text-[12.5px] font-semibold px-4 py-2 rounded-md
                bg-text text-bg hover:bg-text-2
                cursor-pointer transition-colors
              "
            >
              {t("cancel")}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="px-5 py-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-text-3">
                {t("fieldName")}
              </span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                maxLength={200}
                className="
                  bg-bg-elev border border-border rounded-md px-3 py-2
                  text-[13px] text-text
                  focus:outline-none focus:border-text-3
                  disabled:opacity-60
                "
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-text-3">
                {t("fieldEmail")}
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                maxLength={254}
                className="
                  bg-bg-elev border border-border rounded-md px-3 py-2
                  text-[13px] text-text
                  focus:outline-none focus:border-text-3
                  disabled:opacity-60
                "
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-text-3">
                {t("fieldMessage")}
              </span>
              {/* The example is a placeholder, not a default value. A
               *  required field pre-filled with text people can send
               *  unchanged is a required field in name only — and the
               *  whole reason to require it is to learn something the
               *  name and the address do not already say.
               *
               *  Muted and upright, like every other placeholder here
               *  and like every browser default. The app italicises the
               *  text it writes about itself — empty states, hints —
               *  but placeholders are not that family, and no major
               *  design system slants them. */}
              <textarea
                required
                placeholder={t("messagePlaceholder")}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={submitting}
                maxLength={5000}
                rows={3}
                className="
                  bg-bg-elev border border-border rounded-md px-3 py-2
                  text-[13px] text-text leading-[1.5]
                  placeholder:text-text-4
                  focus:outline-none focus:border-text-3
                  disabled:opacity-60 resize-y
                "
              />
            </label>

            {status.kind === "error" && (
              <div className="text-[12px] text-hot-text leading-snug">
                {status.message}
              </div>
            )}

            <p className="text-[11.5px] leading-snug text-text-3 mt-1">
              {t.rich("consent", {
                link: (chunks) => (
                  <Link
                    href="/legal/confidentialite"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 decoration-text-4 hover:decoration-text text-text-2 hover:text-text"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>

            <div className="flex flex-row items-center gap-2 justify-end pt-2 border-t border-border -mx-5 px-5 pb-1 mt-2">
              <button
                type="button"
                onClick={() => close(false)}
                disabled={submitting}
                className="
                  text-[12.5px] font-medium px-3 py-1.5 rounded-md
                  text-text-2 hover:bg-bg-hover hover:text-text
                  cursor-pointer transition-colors
                "
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className={cn(
                  "text-[12.5px] font-semibold px-3 py-1.5 rounded-md transition-colors",
                  submitting
                    ? "bg-bg-sub text-text-4 cursor-not-allowed"
                    : "bg-text text-bg hover:bg-text-2 cursor-pointer",
                )}
              >
                {submitting ? t("submitting") : t("submit")}
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
