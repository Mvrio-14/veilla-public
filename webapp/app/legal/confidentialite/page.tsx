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
    title: fr ? "Politique de confidentialité" : "Privacy Policy",
    description: fr
      ? "Politique de confidentialité de Veilla — collecte, usage et protection des données personnelles."
      : "Veilla's privacy policy — how we collect, use, and protect personal data.",
  };
}

export default async function PrivacyPage() {
  const locale = await getLocale();
  const lang = locale === "fr" ? "fr" : "en";
  const file = path.join(
    process.cwd(),
    "content",
    "legal",
    `confidentialite.${lang}.md`,
  );
  const content = await fs.readFile(file, "utf8");
  const t = await getTranslations("landing.footer.links");
  return (
    <LegalShell
      otherDocHref="/legal/mentions-legales"
      otherDocLabel={t("legalNotice")}
    >
      <LegalMarkdown content={content} />
    </LegalShell>
  );
}
