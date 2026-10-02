"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

export function NoAccessClient({
  email,
  reason,
}: {
  email: string | null;
  reason: "no-profile" | "error";
}) {
  const router = useRouter();
  const t = useTranslations("noAccess");
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <main className="min-h-screen bg-zinc-50 text-zinc-900 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white border border-zinc-200 rounded-lg shadow-sm p-8 text-sm">
        {reason === "no-profile" ? (
          <>
            <h1 className="text-lg font-semibold mb-2">
              {t("noProfileTitle")}
            </h1>
            <p className="text-zinc-600 mb-4">{t("noProfileBody")}</p>
            {email && (
              <p className="text-xs text-zinc-500 mb-4">
                {t.rich("signedInAs", {
                  email,
                  strong: (chunks) => (
                    <span className="font-medium">{chunks}</span>
                  ),
                })}
              </p>
            )}
            <p className="text-xs text-zinc-500 mb-6">
              {t.rich("noProfileHint", {
                code: (chunks) => (
                  <span className="mx-1 px-1 bg-zinc-100 rounded font-mono">
                    {chunks}
                  </span>
                ),
              })}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold mb-2">
              {t("unavailableTitle")}
            </h1>
            <p className="text-zinc-600 mb-4">{t("unavailableBody")}</p>
          </>
        )}

        <div className="flex gap-2 text-xs">
          <button
            onClick={signOut}
            disabled={busy}
            className="px-3 py-1.5 bg-zinc-900 text-white rounded hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy ? "..." : t("signOut")}
          </button>
          <button
            onClick={() => router.refresh()}
            className="px-3 py-1.5 border border-zinc-300 rounded hover:bg-zinc-100"
          >
            {t("retry")}
          </button>
        </div>
      </div>
    </main>
  );
}
