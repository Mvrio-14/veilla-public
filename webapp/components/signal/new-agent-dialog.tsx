"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createWatcher } from "@/lib/actions";
import { cn } from "@/lib/utils";

/**
 * Create an agent: a name and a request. It reads every monitor of the
 * reader to begin with; narrowing that is done on its page, where the
 * list of monitors has room. Created, it opens on its own page, where
 * its first verdicts appear after the next worker pass.
 */
export function NewAgentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[560px] w-[min(560px,calc(100vw-32px))] flex flex-col gap-0 p-0">
        {open && <Body />}
      </DialogContent>
    </Dialog>
  );
}

const FIELD = cn(
  "w-full px-3 py-2 rounded-md bg-bg-sub border border-border",
  "text-[13px] text-text placeholder:text-text-4",
  "outline-none transition-colors focus:border-text-4 focus:bg-bg-elev",
);

function Body() {
  const t = useTranslations("signal.newAgent");
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [request, setRequest] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const canSubmit = name.trim() !== "" && request.trim() !== "" && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setFailed(false);
    try {
      const created = await createWatcher({ name, request, monitor_ids: [] });
      router.push(`/signal/agents/${created.id}`);
      router.refresh();
    } catch (err) {
      console.error("[agents] create failed", err);
      setFailed(true);
      setSubmitting(false);
    }
  };

  return (
    <>
      <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
        <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
          {t("title")}
        </DialogTitle>
        <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
          {t("description")}
        </DialogDescription>
      </DialogHeader>

      <div className="px-5 py-4 space-y-4">
        <label className="block">
          <span className="block text-[12px] font-medium text-text-2 mb-1.5">{t("name")}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("namePlaceholder")}
            maxLength={120}
            autoFocus
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="block text-[12px] font-medium text-text-2 mb-1.5">{t("request")}</span>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            placeholder={t("requestPlaceholder")}
            maxLength={2000}
            rows={5}
            className={cn(FIELD, "resize-y leading-relaxed")}
          />
          <span className="block mt-1.5 text-[11.5px] text-text-4">{t("requestHint")}</span>
        </label>
      </div>

      <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-3 sm:justify-end">
        {failed && (
          <span role="alert" className="mr-auto text-[12px] text-hot">
            {t("failed")}
          </span>
        )}
        <Button variant="solid" size="lg" onClick={submit} disabled={!canSubmit}>
          {submitting ? t("creating") : t("create")}
        </Button>
      </DialogFooter>
    </>
  );
}
