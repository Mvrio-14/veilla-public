"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { createClient } from "@/lib/supabase/client";
import { ContactModal } from "@/components/contact/contact-modal";
import { cn } from "@/lib/utils";

/**
 * Top-right account control. Shows the viewer's identity, not the watch
 * owner's — so on someone else's watch you see your own avatar, not theirs.
 *
 * Anonymous: renders a "Sign in" link.
 * Authenticated: renders the avatar (first letter of email) which opens
 *   a dropdown with email + settings + theme + contact + sign out.
 *
 * ## Why the sales form is reachable from here
 *
 * Free accounts are read-only, so the moment someone most wants to talk
 * to a human is the moment they press Save and cannot. That happens
 * inside the product, long after the landing page is out of sight, and
 * the account menu is where people already look when they want to change
 * something about their account. Putting it anywhere more prominent
 * would nag the users who are content; putting it nowhere would make
 * them hunt for an address.
 *
 * ## Why the theme switch lives here
 *
 * Not in the topbar, beside the connection indicator and the
 * notification bell: those two report something that changes on its own
 * and has to be seen without asking; the theme is a preference set once
 * and then forgotten. Permanent space next to live signals would overstate
 * it, and the account menu is where people look for settings that
 * belong to them rather than to the data.
 *
 * `enableSystem` is false on the provider, so there is no third
 * "system" state to offer — the control is strictly light/dark and one
 * row says all of it.
 *
 * No language switcher: each user has a single content language (set
 * manually in the DB) that the UI follows automatically — set as a
 * cookie at login. If a user really needs to flip locales we'll
 * surface the toggle in a future settings UI.
 */
export function UserMenu() {
  const t = useTranslations("userMenu");
  const tTheme = useTranslations("themeToggle");
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();

  const [open, setOpen] = React.useState(false);
  const [contactOpen, setContactOpen] = React.useState(false);
  const [email, setEmail] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  // Pull current session on mount and subscribe to changes — covers sign-in
  // from another tab without a hard reload.
  React.useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setEmail(user?.email ?? null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setEmail(session?.user?.email ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Click outside closes the dropdown.
  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function handleSignOut() {
    setOpen(false);
    const supabase = createClient();
    await supabase.auth.signOut();
    // Clear the locale cookie too — the next visitor on this browser
    // shouldn't inherit the previous user's language.
    document.cookie = "NEXT_LOCALE=; path=/; max-age=0; SameSite=Lax";
    // Push to home then refresh — refresh() invalidates Server Component
    // caches so the next render sees the cleared session.
    router.push("/");
    router.refresh();
  }

  if (!email) {
    return (
      <Link
        href="/login"
        className="ml-1 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium hover:bg-bg-hover"
      >
        {t("signIn")}
      </Link>
    );
  }

  const initial = email.charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        title={t("account")}
        aria-label={t("openAccountMenu")}
        className={cn(
          "h-[26px] w-[26px] rounded-full bg-accent text-white",
          "flex items-center justify-center text-[11px] font-semibold tracking-tight",
          "select-none ml-1 cursor-pointer",
          open && "ring-2 ring-accent-soft ring-offset-1",
        )}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 w-[220px] bg-bg-elev border border-border-strong rounded-md shadow-lg z-50 py-1 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border-strong">
            <div className="text-[11px] text-text-3 mb-0.5">{t("signedInAs")}</div>
            <div className="text-[12.5px] font-medium truncate">{email}</div>
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-bg-hover cursor-pointer"
          >
            {t("settings")}
          </Link>
          {/* This is the only theme control in the app; the landing, login
           *  and legal pages are forced light.
           *
           *  No `mounted` guard is needed here: a control rendered during
           *  hydration would mismatch, while this markup only exists once
           *  the menu is open — which cannot happen before a click, long
           *  after next-themes has resolved.
           *
           *  The menu deliberately stays open. Settings and Contact both
           *  take you elsewhere, so closing is part of the action; this
           *  one changes the page you are already looking at, and the
           *  label flipping to its opposite is the confirmation that the
           *  click landed. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-bg-hover cursor-pointer"
          >
            {resolvedTheme === "dark"
              ? tTheme("switchToLight")
              : tTheme("switchToDark")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setContactOpen(true);
            }}
            className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-bg-hover cursor-pointer"
          >
            {t("contact")}
          </button>
          <div className="h-px bg-border-strong my-1" />
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            className="w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-bg-hover cursor-pointer"
          >
            {t("signOut")}
          </button>
        </div>
      )}

      <ContactModal open={contactOpen} onOpenChange={setContactOpen} />
    </div>
  );
}
