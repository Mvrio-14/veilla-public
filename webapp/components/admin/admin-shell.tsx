"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Admin chrome — distinct from the user-facing AppShell on purpose.
 *
 *  - Monospaced everything: the surface should read as a tool, not a product.
 *  - Yellow accent on the top strip: visible "you are in dev tooling" cue
 *    so a tab in the background can't be confused with /watch.
 *  - Minimal sidebar with the sections (feeds+sources, users, audit).
 *  - Admin email surfaced in the topbar so you always know "as whom".
 *
 * Intentionally NOT polished — this is V1 dev surface for the operator as the
 * sole admin. We'll prettify if/when ops join.
 */
export function AdminShell({
  adminEmail,
  children,
}: {
  adminEmail: string;
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-text font-mono text-[13px]">
      <TopBar adminEmail={adminEmail} />
      <div className="flex-1 flex overflow-hidden">
        <NavSidebar />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}


function TopBar({ adminEmail }: { adminEmail: string }) {
  return (
    <div className="h-9 shrink-0 px-4 flex items-center justify-between
                    bg-[#FFF8C4] dark:bg-[#5a4400] text-text border-b border-border">
      <div className="flex items-center gap-4">
        <Link href="/admin" className="font-bold uppercase tracking-wider">
          Veilla — admin
        </Link>
        <span className="text-text-3 text-[11.5px]">
          dev-tool · DB-as-truth · ADMIN_EMAILS gated
        </span>
      </div>
      <div className="flex items-center gap-3 text-[11.5px]">
        <span className="text-text-3">{adminEmail}</span>
        <Link
          href="/watch"
          className="px-2 py-0.5 rounded border border-text-3 hover:bg-bg-hover"
          title="Back to the user app"
        >
          ← /watch
        </Link>
      </div>
    </div>
  );
}


/**
 * Static left rail with the admin sections. Each link uses the
 * current pathname to mark the active section. No collapse / animation
 * — keep the chrome dumb.
 */
function NavSidebar() {
  const pathname = usePathname() ?? "";
  const sections: { href: string; label: string; description: string }[] = [
    { href: "/admin/sources", label: "Sources & Feeds", description: "RSS feeds, sources, probe + lifecycle" },
    { href: "/admin/users",   label: "Users",           description: "Accounts + their plan" },
    { href: "/admin/audit",   label: "Audit log",       description: "Recent admin actions" },
  ];

  return (
    <aside className="w-[200px] shrink-0 border-r border-border bg-bg-sub overflow-y-auto py-3 px-2 flex flex-col gap-px">
      {sections.map((s) => {
        const active = pathname === s.href || pathname.startsWith(s.href + "/");
        return (
          <Link
            key={s.href}
            href={s.href}
            title={s.description}
            className={cn(
              "px-2 py-1.5 rounded text-[12px] uppercase tracking-wider",
              active
                ? "bg-bg-active text-text font-bold"
                : "text-text-2 hover:bg-bg-hover hover:text-text",
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </aside>
  );
}
