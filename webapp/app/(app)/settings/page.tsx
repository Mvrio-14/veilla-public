import { redirect } from "next/navigation";

/**
 * `/settings` is a shell route — there's nothing to display at its
 * root. We redirect to the first functional sub-tab (Préférences).
 * Other sub-tabs (Feeds / Notifications / Profil) are placeholder
 * pages that the layout's sidebar surfaces, but they don't have
 * content yet.
 */
export default function SettingsPage() {
  redirect("/settings/preferences");
}
