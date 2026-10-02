"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft } from "lucide-react";
import { EyeMark } from "@/components/eye-mark";

/**
 * Shell for the /legal/* pages: a plain header (logo, a way back home, a
 * theme toggle), content centred at 720px, and a minimal footer linking
 * to the other legal document. No demo call to action — these pages sit
 * outside the marketing context, and asking for a signup next to a
 * privacy policy reads badly.
 */
export function LegalShell({
  children,
  otherDocHref,
  otherDocLabel,
}: {
  children: React.ReactNode;
  otherDocHref: string;
  otherDocLabel: string;
}) {
  const t = useTranslations("legal");
  return (
    <div className="min-h-screen flex flex-col bg-bg text-text">
      <header className="border-b border-border">
        <div className="mx-auto max-w-[1240px] px-8 max-[720px]:px-5 h-14 flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-2 no-underline group"
          >
            <ArrowLeft
              size={16}
              className="text-text-3 group-hover:text-text transition-colors"
              aria-hidden
            />
            <EyeMark size={21} decorative />
            <span className="font-wordmark text-[13px] font-medium tracking-[0.24em] uppercase text-text pl-[2px]">
              Veilla
            </span>
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <article className="mx-auto max-w-[720px] px-8 max-[720px]:px-5 py-16 max-[720px]:py-10">
          {children}
        </article>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-[1240px] px-8 max-[720px]:px-5 py-6 flex items-center justify-between gap-4 flex-wrap text-[12px] text-text-3">
          <Link
            href={otherDocHref}
            className="text-text-2 no-underline hover:text-text"
          >
            {otherDocLabel}
          </Link>
          <span className="font-mono tracking-[0.04em]">{t("copy")}</span>
        </div>
      </footer>
    </div>
  );
}
