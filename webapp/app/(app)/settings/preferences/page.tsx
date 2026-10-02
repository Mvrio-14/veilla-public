import { getTranslations } from "next-intl/server";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { fetchPreferences } from "@/lib/api";
import { requireViewer } from "@/lib/auth/viewer";
import { emptyAdvanced } from "@/lib/filter";

/**
 * Settings → Préférences. Server-fetches the user's persisted prefs
 * and hands them to the client form for editing. Saving goes through
 * the client action `updatePreferences`.
 *
 * Falls back silently to `emptyAdvanced` on fetch failure so the form
 * always renders (the user can still configure and submit; the PUT
 * call carries its own error handling).
 */
export default async function SettingsPreferencesPage() {
  const t = await getTranslations("settings.preferences");
  const { accessToken } = await requireViewer("/settings/preferences");

  let initial = emptyAdvanced;
  try {
    initial = await fetchPreferences(accessToken);
  } catch (err) {
    // Network blip / 5xx — render the form with empty defaults so the
    // user can still interact. Their save will retry against the API.
    console.warn("[settings] fetchPreferences failed", err);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-[-0.012em] text-text mb-1">
          {t("title")}
        </h1>
        <p className="text-[13px] text-text-3 leading-relaxed">{t("intro")}</p>
      </header>

      <PreferencesForm initial={initial} />
    </div>
  );
}
