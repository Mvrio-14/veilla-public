import Link from "next/link";

/**
 * /admin home — landing page that surfaces the sections so the
 * admin lands somewhere meaningful instead of an empty layout.
 * The same links live in the sidebar; this page exists for the
 * default route + a per-section description.
 */
export default function AdminHome() {
  const sections: { href: string; title: string; body: string }[] = [
    {
      href:  "/admin/sources",
      title: "Sources & Feeds",
      body:  "Add new RSS feeds, probe URLs before saving, edit source metadata, soft-delete or resurrect dead feeds.",
    },
    {
      href:  "/admin/users",
      title: "Users",
      body:  "List users, configure their language, plan and active status. The login itself is created in Supabase Auth.",
    },
    {
      href:  "/admin/audit",
      title: "Audit log",
      body:  "Recent mutations: who did what, on which entity, when. Read-only.",
    },
  ];

  return (
    <div className="max-w-3xl">
      <h1 className="text-[16px] font-bold uppercase tracking-wider mb-1">
        Admin
      </h1>
      <p className="text-text-3 mb-6">
        Dev tooling for managing the catalog and users without
        editing JSON files. DB is the source of truth; every mutation
        is logged to <code>admin_actions</code>.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block p-3 border border-border rounded bg-bg-sub hover:bg-bg-hover transition-colors"
          >
            <div className="font-bold uppercase tracking-wider mb-1">
              {s.title}
            </div>
            <div className="text-text-3 text-[12px]">{s.body}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
