import { SettingsTabs } from "@/components/settings/settings-tabs";

/**
 * Settings layout — left-column vertical tabs + right-column content.
 *
 * Each sub-route (preferences / feeds / notifications / profile) sits
 * in its own `page.tsx` under this layout, so the tabs persist as the
 * user clicks between them without re-mounting the surrounding chrome.
 *
 * Mirrors the pattern in Linear / Notion / GitHub: shell on the left
 * is a small nav (~200px), the right pane scrolls independently.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main className="flex-1 flex min-h-0 bg-bg">
      <SettingsTabs />
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[720px] mx-auto px-8 py-8">{children}</div>
      </div>
    </main>
  );
}
