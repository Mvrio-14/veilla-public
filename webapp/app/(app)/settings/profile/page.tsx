import { getTranslations } from "next-intl/server";
import { SettingsPlaceholder } from "@/components/settings/settings-placeholder";

export default async function SettingsProfilePage() {
  const t = await getTranslations("settings.profile");
  return (
    <SettingsPlaceholder title={t("title")} description={t("comingSoon")} />
  );
}
