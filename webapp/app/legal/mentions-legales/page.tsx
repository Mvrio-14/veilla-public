import { promises as fs } from "fs";
import path from "path";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { LegalShell } from "@/components/legal/legal-shell";
import { LegalMarkdown } from "@/components/legal/legal-markdown";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const fr = locale === "fr";
  return {
    title: fr ? "Mentions légales" : "Legal Notice",
    description: fr
      ? "Mentions légales de Veilla — éditeur, directeur de la publication, hébergement."
      : "Veilla's legal notice — publisher, publication director, hosting providers.",
  };
}

export default async function LegalNoticePage() {
  const locale = await getLocale();
  const lang = locale === "fr" ? "fr" : "en";
  const file = path.join(
    process.cwd(),
    "content",
    "legal",
    `mentions-legales.${lang}.md`,
  );
  const content = await fs.readFile(file, "utf8");
  const t = await getTranslations("landing.footer.links");
  return (
    <LegalShell
      otherDocHref="/legal/confidentialite"
      otherDocLabel={t("privacy")}
    >
      <LegalMarkdown content={content} />
    </LegalShell>
  );
}
