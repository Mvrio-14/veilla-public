"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { EyeMark } from "@/components/eye-mark";

/**
 * Compact footer — Product, Contact and Legal columns. Bottom row is just
 * the copyright (the original handoff had nothing else on it either).
 *
 * This is the one place where all four ways in sit side by side: read
 * about it, try it, sign back in, or ask for a newsroom deployment. A
 * footer is where someone looks once they have decided and cannot find
 * the control they want higher up, so nothing is filtered out here.
 */
export function LandingFooter({ onContactClick }: { onContactClick: () => void }) {
  const t = useTranslations("landing");
  return (
    // The page keeps scrolling past the columns, but the last line is not
    // left floating in the middle of that space: the height is spent
    // ABOVE the copyright, which stays pinned to the very bottom where a
    // copyright belongs. Padding below it would have done the opposite.
    <footer className="border-t border-border pt-10 pb-8 mt-20">
      <div className="mx-auto max-w-[1240px] px-8 max-[720px]:px-5">
        <div className="flex items-start justify-between gap-8 flex-wrap">
          <div className="max-w-[280px]">
            <Link href="/" className="inline-flex items-center gap-3 no-underline">
              <EyeMark size={38} decorative />
              <span className="font-wordmark text-[22px] font-medium tracking-[0.24em] uppercase text-text pl-[3px]">
                Veilla
              </span>
            </Link>
          </div>

          <div className="flex gap-12 flex-wrap">
            {/* The two products first, because they are what the page has
                just spent itself explaining. Desk and Signal point at the
                section that names them — neither has a page of its own
                yet, and a footer that hides its main nouns to avoid an
                anchor is worse than one that scrolls. */}
            <div className="flex flex-col gap-2 min-w-[140px]">
              <h5 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3 m-0 mb-1">{t("footer.colProduct")}</h5>
              <a href="#products" className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.desk")}
              </a>
              <a href="#products" className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.signal")}
              </a>
            </div>

            <div className="flex flex-col gap-2 min-w-[160px]">
              <h5 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3 m-0 mb-1">{t("footer.colCompany")}</h5>
              <a href="#partners" className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.partners")}
              </a>
              <button type="button" onClick={onContactClick} className="text-[15px] text-text-2 hover:text-text bg-transparent border-0 p-0 cursor-pointer text-left">
                {t("footer.links.contact")}
              </button>
              <a href={`mailto:${t("footer.links.email")}`} className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.email")}
              </a>
            </div>

            <div className="flex flex-col gap-2 min-w-[160px]">
              <h5 className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-text-3 m-0 mb-1">{t("footer.colLegal")}</h5>
              <Link href="/legal/confidentialite" className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.privacy")}
              </Link>
              <Link href="/legal/mentions-legales" className="text-[15px] text-text-2 no-underline hover:text-text">
                {t("footer.links.legalNotice")}
              </Link>
            </div>
          </div>
        </div>

        {/* The last line of the page carries two things, one at each end.
            The hosting fact belongs here rather than beside the buttons:
            it answers a question about the company, not about the offer,
            and this is where a reader looks for that kind of statement.
            `justify-between` puts it on the right with no extra rule. */}
        <div className="mt-36 flex flex-wrap justify-between gap-x-8 gap-y-2 font-mono text-[12px] tracking-[0.04em] text-text-3 max-[720px]:mt-24">
          <span>{t("footer.copy")}</span>
          <span>{t("footer.hosting")}</span>
        </div>
      </div>
    </footer>
  );
}
