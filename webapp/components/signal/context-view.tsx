"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ProseEditor } from "@/components/ui/prose-editor";
import { saveContext } from "@/lib/actions";
import { useCanWrite } from "@/lib/auth/can-write";
import { fmtAbsolute } from "@/lib/format";
import type { ReadingContext } from "@/lib/signal";

/**
 * The Context screen — who the agents are reading for.
 *
 * One paragraph, shared by every agent, given to each alongside its own
 * request. It holds what does not change from one request to the next
 * (the reader's beat, audience, what they count as news) so that it is
 * written once rather than repeated, slightly differently, in every
 * agent.
 */

export function ContextView({ context }: { context: ReadingContext }) {
  const t = useTranslations("signal.context");
  const locale = useLocale();
  const router = useRouter();
  const canWrite = useCanWrite();

  return (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-7 pt-8 pb-10">
        <h1 className="text-[28px] font-normal tracking-[-0.02em] leading-tight">{t("title")}</h1>
        {context.updated_at && (
          <p className="mt-1 text-[12px] text-text-3">
            {t("updated", { when: fmtAbsolute(context.updated_at, locale) })}
          </p>
        )}
        <p className="mt-4 text-[13px] leading-relaxed text-text-2">{t("intro")}</p>

        <div className="mt-6">
          <ProseEditor
            value={context.body}
            onSave={async (body) => {
              await saveContext(body);
              router.refresh();
            }}
            readOnly={!canWrite}
            label={t("label")}
            hint={t("hint")}
            versionNote={t("note")}
            placeholder={t("placeholder")}
          />
        </div>
      </div>
    </main>
  );
}
