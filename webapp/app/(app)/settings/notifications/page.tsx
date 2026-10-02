import { getTranslations } from "next-intl/server";
import { NotifPrefsForm } from "@/components/settings/notif-prefs-form";
import { fetchNotifPrefs, type NotifPrefs } from "@/lib/api";
import { requireViewer } from "@/lib/auth/viewer";

/**
 * Settings → Notifications. Server-fetches the user's per-type channel
 * preferences (3 groups × 2 channels) and hands them to the client
 * form for editing.
 *
 * Defaults the form to a sane "all in-app on, email only on
 * story_follow" shape when the API call fails — keeps the surface
 * editable even on a transient backend hiccup.
 */
export default async function SettingsNotificationsPage() {
  const t = await getTranslations("settings.notifications");
  const { accessToken } = await requireViewer("/settings/notifications");

  // Server-side defaults mirror DEFAULT_NOTIF_PREFS in src/notifications.py.
  // Used only when the fetch fails — on success the API echoes the
  // canonical merged shape.
  let initial: NotifPrefs = {
    story_follow: { in_app: true, email: true, include_new_articles: false },
  };
  try {
    initial = await fetchNotifPrefs(accessToken);
  } catch (err) {
    // Best-effort — falls back to the defaults above. Warn (not error)
    // since the page still renders fine and the user can submit; the
    // PUT round-trip will either succeed or surface its own toast.
    console.warn("[settings] fetchNotifPrefs failed", err);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[18px] font-semibold tracking-[-0.012em] text-text mb-1">
          {t("title")}
        </h1>
        <p className="text-[13px] text-text-3 leading-relaxed">{t("intro")}</p>
      </header>
      <NotifPrefsForm initial={initial} />
    </div>
  );
}
