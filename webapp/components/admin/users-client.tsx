"use client";

import * as React from "react";
import {
  type AdminUser,
  createUser,
  listUsers,
  updateUser,
} from "@/lib/admin/api";
import { cn } from "@/lib/utils";
import { useChanged } from "@/lib/use-changed";


/**
 * /admin/users main client.
 *
 * Layout: list of users (left) + selected user detail (right). The
 * detail edits name / slug / email / output_lang / active / is_public and
 * the plan, which decides whether the account may write.
 *
 * Creation: "+ Create user" inserts a row into public.users (slug + email
 * required). The Supabase Auth account still gets created separately via
 * the Supabase Dashboard — the `auth_id` links at first login via email
 * match.
 */
export function UsersClient() {
  const [users, setUsers]           = React.useState<AdminUser[]>([]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading]       = React.useState(true);
  const [error, setError]           = React.useState<string | null>(null);
  const [query, setQuery]           = React.useState("");
  const [showInactive, setShowInactive] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);

  /** Load on mount. `listUsers` touches no React state — which is what
   *  lets the effect update state only from inside a promise callback. */
  React.useEffect(() => {
    let alive = true;
    listUsers()
      .then((u) => {
        if (!alive) return;
        setUsers(u);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** Reload after a mutation. Called from event handlers, where setting
   *  state up front is exactly right — the click is the trigger. */
  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUsers(await listUsers());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const filteredUsers = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (!showInactive && !u.active) return false;
      if (!q) return true;
      return (
        (u.name ?? "").toLowerCase().includes(q) ||
        u.slug.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q)
      );
    });
  }, [users, query, showInactive]);

  const selectedUser = selectedId
    ? users.find((u) => u.id === selectedId) ?? null
    : null;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[16px] font-bold uppercase tracking-wider">
            Users
          </h1>
          <p className="text-text-3 text-[12px]">
            {users.length} users {loading && " · loading…"}
            {error && <span className="text-bad ml-2">· {error}</span>}
            <span className="ml-2 text-text-4">
              · creates public.users — Supabase Auth still via Dashboard
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-[12px] flex items-center gap-1.5 select-none cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show inactive
          </label>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[12px] font-bold hover:opacity-90"
          >
            + Create user
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[300px,1fr] gap-3 h-[calc(100vh-180px)]">
        <UsersList
          users={filteredUsers}
          totalUsers={users.length}
          selectedId={selectedId}
          onSelect={setSelectedId}
          query={query}
          onQueryChange={setQuery}
        />
        {selectedUser ? (
          <UserDetail user={selectedUser} onChanged={refresh} />
        ) : (
          <div className="border border-border rounded p-6 text-text-3 text-center italic">
            Select a user to edit their profile and plan.
          </div>
        )}
      </div>

      {showCreate && (
        <CreateUserDialog
          onClose={() => setShowCreate(false)}
          onSaved={async (newUser) => {
            setShowCreate(false);
            await refresh();
            setSelectedId(newUser.id);
          }}
        />
      )}
    </div>
  );
}


// ── Users list ─────────────────────────────────────────────────────────
function UsersList({
  users, totalUsers, selectedId, onSelect, query, onQueryChange,
}: {
  users: AdminUser[];
  totalUsers: number;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  return (
    <aside className="border border-border rounded bg-bg-sub flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-border bg-bg-sub sticky top-0">
        <div className="flex items-center justify-between mb-1.5">
          <h2 className="text-[12px] uppercase tracking-wider font-bold">
            Accounts
          </h2>
          <span className="text-[10.5px] text-text-3 tabular-nums">
            {users.length === totalUsers ? totalUsers : `${users.length} / ${totalUsers}`}
          </span>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search name / slug / email…"
          className="w-full px-2 py-1 rounded border border-border bg-bg text-text font-mono text-[11.5px]"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {users.length === 0 ? (
          <div className="px-3 py-4 text-text-3 text-[11.5px] italic">
            No users match.
          </div>
        ) : users.map((u) => {
          const active = u.id === selectedId;
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => onSelect(active ? null : u.id)}
              className={cn(
                "block w-full text-left px-3 py-1.5 border-b border-border/50",
                active
                  ? "bg-bg-active text-text font-bold"
                  : "text-text-2 hover:bg-bg-hover",
                !u.active && "opacity-60",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[12px] truncate">{u.name || "(no name)"}</div>
                {!u.active ? (
                  <span className="text-[9.5px] uppercase tracking-wider font-bold text-bad shrink-0">
                    inactive
                  </span>
                ) : u.plan === "pro" && (
                  <span className="text-[9.5px] uppercase tracking-wider font-bold text-good shrink-0">
                    pro
                  </span>
                )}
              </div>
              <div className="text-[10.5px] text-text-3 truncate">
                {u.slug} · {u.email}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}


// ── User detail (right pane) ────────────────────────────────────────────
function UserDetail({
  user, onChanged,
}: {
  user: AdminUser;
  onChanged: () => void | Promise<void>;
}) {
  return (
    <div className="border border-border rounded bg-bg-sub overflow-auto p-3 space-y-4">
      <UserReadonlyPanel user={user} />
      <UserProfilePanel user={user} onChanged={onChanged} />
    </div>
  );
}


/** Compact header — surfaces user_id + timestamps + status badge.
 *  The actual editable fields are in `UserProfilePanel` below. */
function UserReadonlyPanel({ user }: { user: AdminUser }) {
  return (
    <section className="border border-border rounded p-3 bg-bg">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-[12px] uppercase tracking-wider font-bold">
          {user.name || "(no name)"}
        </h2>
        <div className="flex items-center gap-2 text-[9.5px] uppercase tracking-wider font-bold">
          <span className={user.active    ? "text-good"  : "text-bad"}>
            {user.active ? "active" : "inactive"}
          </span>
          <span className={user.is_public ? "text-warn"  : "text-text-3"}>
            {user.is_public ? "public" : "private"}
          </span>
          <span className={user.plan === "pro" ? "text-good" : "text-text-3"}>
            {user.plan}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11.5px]">
        <div>
          <span className="text-text-3">User ID:</span>{" "}
          <span className="font-mono text-[10.5px]">{user.id}</span>
        </div>
        {user.updated_at && (
          <div>
            <span className="text-text-3">Updated:</span>{" "}
            <span className="font-mono text-[10.5px]">
              {new Date(user.updated_at).toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}


function UserProfilePanel({
  user, onChanged,
}: {
  user: AdminUser;
  onChanged: () => void | Promise<void>;
}) {
  const [name,     setName]     = React.useState(user.name ?? "");
  const [slug,     setSlug]     = React.useState(user.slug);
  const [email,    setEmail]    = React.useState(user.email);
  const [lang,     setLang]     = React.useState(user.output_lang ?? "");
  const [active,   setActive]   = React.useState(user.active);
  const [isPublic, setIsPublic] = React.useState(user.is_public);
  const [isPro,    setIsPro]    = React.useState(user.plan === "pro");
  const [saving,   setSaving]   = React.useState(false);
  const [err,      setErr]      = React.useState<string | null>(null);

  // Reset when the selected user changes, or when a refetch changes the
  // one on screen. Done during render so the form never paints with the
  // previous user's values.
  const userSnapshot = [
    user.id, user.name, user.slug, user.email,
    user.output_lang, user.active, user.is_public, user.plan,
  ].join("|");
  if (useChanged(userSnapshot)) {
    setName(user.name ?? "");
    setSlug(user.slug);
    setEmail(user.email);
    setLang(user.output_lang ?? "");
    setActive(user.active);
    setIsPublic(user.is_public);
    setIsPro(user.plan === "pro");
  }

  const dirty =
    name     !== (user.name ?? "")          ||
    slug     !== user.slug                  ||
    email    !== user.email                 ||
    lang     !== (user.output_lang ?? "")   ||
    active   !== user.active                ||
    isPublic !== user.is_public             ||
    isPro    !== (user.plan === "pro");

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await updateUser(user.id, {
        name:        name.trim()  || null,
        slug:        slug.trim().toLowerCase(),
        email:       email.trim().toLowerCase(),
        output_lang: lang.trim().toLowerCase(),
        active,
        is_public:   isPublic,
        plan:        isPro ? "pro" : "demo",
      });
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const slugChanged  = slug  !== user.slug;
  const emailChanged = email !== user.email;

  return (
    <section className="border border-border rounded p-3 bg-bg">
      <h2 className="text-[12px] uppercase tracking-wider font-bold mb-2">
        Profile
      </h2>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" value={name} onChange={setName} />
        <Field
          label="Output lang (ISO 639-1)"
          value={lang}
          onChange={(v) => setLang(v.toLowerCase())}
        />
        <Field
          label="Slug (URL identifier — DANGER if changed)"
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
        />
        <Field
          label="Email (cosmetic — Supabase Auth login unchanged)"
          value={email}
          onChange={setEmail}
        />
      </div>

      {/* Inline warnings — only render when the field is dirty so the
       *  panel stays clean on the typical "no edit" path. */}
      {slugChanged && (
        <div className="mt-2 text-[11px] text-warn border-l-2 border-warn pl-2">
          ⚠ Changing the slug breaks deep links to
          <code className="mx-1 px-1 bg-bg-sub rounded">/users/{user.slug}/…</code>
          and the legacy
          <code className="mx-1 px-1 bg-bg-sub rounded">config/users/{user.slug}/</code>
          file path. Use only on freshly-onboarded accounts.
        </div>
      )}
      {emailChanged && (
        <div className="mt-2 text-[11px] text-warn border-l-2 border-warn pl-2">
          ⚠ Editing this field updates <code className="mx-1 px-1 bg-bg-sub rounded">public.users.email</code> only.
          The user&apos;s Supabase Auth login email is unchanged — they keep signing in with
          {" "}<code className="mx-1 px-1 bg-bg-sub rounded">{user.email}</code>.
          To change the real login, go to Supabase Dashboard → Authentication → Users.
        </div>
      )}

      <div className="flex flex-col gap-1.5 mt-3 text-[12px]">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <span>
            <strong>Active</strong> — uncheck to suspend reads + writes for this user.
          </span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span>
            <strong>Public profile</strong> — when checked, the
            <code className="mx-1 px-1 bg-bg-sub rounded">/users/{user.slug}/watch</code>
            page is reachable without auth (anon-readable demo profile).
          </span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isPro}
            onChange={(e) => setIsPro(e.target.checked)}
          />
          <span>
            <strong>Pro plan</strong> — can save stories, file them into
            folders and create views. Unchecked, the account is read-only.
          </span>
        </label>
      </div>

      {err && <div className="text-bad text-[12px] mt-2">{err}</div>}
      <div className="flex justify-end mt-2">
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[11.5px] font-bold disabled:opacity-30"
        >
          {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </section>
  );
}


function Field({
  label, value, onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-0.5">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded border border-border bg-bg-sub text-text font-mono"
      />
    </div>
  );
}


/**
 * "+ Create user" dialog.
 *
 * Creates a row in public.users. The Supabase Auth account still has to
 * be created separately via the Supabase Dashboard (email + password,
 * Auto-Confirm User = ON). The link between the two happens lazily at
 * first login via email match → auth_id.
 *
 * Required fields: slug + email. Everything else has a sensible default.
 */
function CreateUserDialog({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: (user: AdminUser) => void | Promise<void>;
}) {
  const [slug,       setSlug]       = React.useState("");
  const [email,      setEmail]      = React.useState("");
  const [name,       setName]       = React.useState("");
  const [outputLang, setOutputLang] = React.useState("fr");
  const [active,     setActive]     = React.useState(true);
  const [isPublic,   setIsPublic]   = React.useState(false);
  const [isPro,      setIsPro]      = React.useState(false);
  const [saving,     setSaving]     = React.useState(false);
  const [err,        setErr]        = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true); setErr(null);
    try {
      const user = await createUser({
        slug:        slug.trim(),
        email:       email.trim(),
        name:        name.trim() || null,
        output_lang: outputLang,
        active,
        is_public:   isPublic,
        plan:        isPro ? "pro" : "demo",
      });
      await onSaved(user);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = slug.trim().length > 0 && email.trim().length > 0;

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-bg border border-border rounded w-[440px]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-border flex justify-between items-center">
          <h2 className="font-bold uppercase tracking-wider">Create user</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-3 hover:text-text"
          >
            ✕
          </button>
        </header>

        <div className="p-4 space-y-3">
          <Field
            label="Slug (URL-safe, e.g. maxime-dupont)"
            value={slug}
            onChange={(v) => setSlug(v.toLowerCase().replace(/[^a-z0-9-_]/g, ""))}
          />
          <Field label="Email" value={email} onChange={setEmail} />
          <Field label="Name (optional)" value={name} onChange={setName} />

          <div>
            <label className="text-[10.5px] uppercase tracking-wider text-text-3 block mb-0.5">
              Output language
            </label>
            <select
              value={outputLang}
              onChange={(e) => setOutputLang(e.target.value)}
              className="w-full px-2 py-1 rounded border border-border bg-bg text-text font-mono"
            >
              <option value="fr">fr</option>
              <option value="en">en</option>
            </select>
          </div>

          <div className="flex gap-4 pt-1">
            <label className="text-[12px] flex items-center gap-1.5 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              Active
            </label>
            <label className="text-[12px] flex items-center gap-1.5 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
              />
              Public
            </label>
            <label className="text-[12px] flex items-center gap-1.5 select-none cursor-pointer">
              <input
                type="checkbox"
                checked={isPro}
                onChange={(e) => setIsPro(e.target.checked)}
              />
              Pro
            </label>
          </div>

          <div className="text-[11px] text-text-3 leading-relaxed pt-1 border-t border-border/50 mt-2">
            <strong className="font-semibold text-text-2">Next step:</strong>{" "}
            create the matching account in the Supabase Auth Dashboard
            (same email, password, Auto-Confirm User = ON). The two rows
            link automatically at first login.
          </div>

          {err && <div className="text-bad text-[12px]">{err}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 rounded border border-border uppercase tracking-wider text-[11.5px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!canSubmit || saving}
              className="px-3 py-1 rounded bg-text text-bg uppercase tracking-wider text-[11.5px] font-bold disabled:opacity-30"
            >
              {saving ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
