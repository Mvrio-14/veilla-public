"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, Mail, Save, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { updateNotifPrefs } from "@/lib/actions";
import type { NotifPrefs } from "@/lib/api";
import { useChanged } from "@/lib/use-changed";

/**
 * Settings → Notifications form. One row per notification group (today
 * only `story_follow`), two checkboxes per row (in_app / email). Both
 * flags off = type fully muted.
 *
 * Explicit Save / Cancel buttons (same pattern as PreferencesForm). Dirty tracking compares against the initial mount value
 * so toggling a flag and toggling it back resets to clean.
 */

const GROUP_KEYS = ["story_follow"] as const;
type GroupKey = (typeof GROUP_KEYS)[number];

function samePrefs(a: NotifPrefs, b: NotifPrefs): boolean {
  for (const k of GROUP_KEYS) {
    if (a[k].in_app !== b[k].in_app) return false;
    if (a[k].email  !== b[k].email)  return false;
  }
  // story_follow carries the article-granularity sub-toggle too.
  if (a.story_follow.include_new_articles !== b.story_follow.include_new_articles) {
    return false;
  }
  return true;
}

export function NotifPrefsForm({ initial }: { initial: NotifPrefs }) {
  const t = useTranslations("settings.notifications");
  const router = useRouter();
  const toast = useToast();

  const [form, setForm] = React.useState<NotifPrefs>(initial);
  const [saving, setSaving] = React.useState(false);

  // A save round-trip hands back the stored preferences; the form
  // follows them. Done during render so `dirty` is never briefly true
  // against values that have already been written.
  if (useChanged(initial)) setForm(initial);

  const dirty = !samePrefs(form, initial);

  const toggle = (group: GroupKey, channel: "in_app" | "email") => {
    setForm((f) => ({
      ...f,
      [group]: { ...f[group], [channel]: !f[group][channel] },
    }));
  };

  const onSave = async () => {
    setSaving(true);
    try {
      const saved = await updateNotifPrefs(form);
      setForm(saved);
      toast.show(t("saved"));
      router.refresh();
    } catch (err) {
      console.error("[settings] updateNotifPrefs failed", err);
      toast.show(t("saveError"), "error");
    } finally {
      setSaving(false);
    }
  };

  const onCancel = () => setForm(initial);

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div
        className={cn(
          "grid grid-cols-[1fr_84px_84px] items-center gap-3",
          "border-b border-border pb-2",
          "text-[11px] font-semibold uppercase tracking-[0.06em] text-text-3",
        )}
      >
        <span>{t("typeColumn")}</span>
        <span className="inline-flex items-center justify-center gap-1.5">
          <Bell size={11} strokeWidth={1.8} aria-hidden />
          {t("inAppColumn")}
        </span>
        <span className="inline-flex items-center justify-center gap-1.5">
          <Mail size={11} strokeWidth={1.8} aria-hidden />
          {t("emailColumn")}
        </span>
      </div>

      {/* Group rows */}
      {GROUP_KEYS.map((g) => {
        const channels = form[g];
        const muted = !channels.in_app && !channels.email;
        return (
          <div key={g} className="space-y-2.5">
            <div className="grid grid-cols-[1fr_84px_84px] items-start gap-3">
              <div>
                <div
                  className={cn(
                    "text-[13px] font-medium",
                    muted ? "text-text-3 line-through" : "text-text",
                  )}
                >
                  {t(`group.${g}.label`)}
                </div>
                <p className="text-[12px] text-text-3 leading-relaxed mt-0.5">
                  {t(`group.${g}.hint`)}
                </p>
                {muted && (
                  <p className="text-[11px] text-text-4 italic mt-1">
                    {t("mutedHint")}
                  </p>
                )}
              </div>
              <div className="flex justify-center pt-1">
                <Toggle
                  checked={channels.in_app}
                  onChange={() => toggle(g, "in_app")}
                  aria-label={t(`group.${g}.ariaInApp`)}
                />
              </div>
              <div className="flex justify-center pt-1">
                <Toggle
                  checked={channels.email}
                  onChange={() => toggle(g, "email")}
                  aria-label={t(`group.${g}.ariaEmail`)}
                />
              </div>
            </div>

            {/* story_follow sub-toggle — only meaningful when at least
             *  one channel is enabled (= muted rows hide it to keep
             *  the form scannable). */}
            {g === "story_follow" && !muted && (
              <div className="pl-4 ml-2 border-l-2 border-border">
                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.story_follow.include_new_articles}
                    onChange={() =>
                      setForm((f) => ({
                        ...f,
                        story_follow: {
                          ...f.story_follow,
                          include_new_articles: !f.story_follow.include_new_articles,
                        },
                      }))
                    }
                    className="mt-0.5 size-3.5 accent-text rounded cursor-pointer"
                  />
                  <div>
                    <div className="text-[12.5px] text-text-2 leading-snug">
                      {t("storyFollowIncludeArticles")}
                    </div>
                    <p className="text-[11px] text-text-4 leading-relaxed mt-0.5">
                      {t("storyFollowIncludeArticlesHint")}
                    </p>
                  </div>
                </label>
              </div>
            )}
          </div>
        );
      })}

      {/* Save action bar */}
      <div
        className={cn(
          "flex items-center gap-2 pt-4 border-t border-border",
          "sticky bottom-0 bg-bg pb-1 -mx-8 px-8",
        )}
      >
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "text-[12.5px] font-medium",
            "border border-accent/40 bg-accent text-bg",
            "hover:brightness-105 transition",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <Save size={13} strokeWidth={1.9} />
          {t("save")}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={!dirty || saving}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md",
            "text-[12.5px] font-medium",
            "border border-border bg-bg-sub text-text-2",
            "hover:bg-bg-hover hover:text-text transition",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
        >
          <X size={13} strokeWidth={1.9} />
          {t("cancel")}
        </button>

        {dirty && (
          <span className="text-[11px] text-text-4 italic">
            {t("unsavedHint")}
          </span>
        )}
      </div>
    </div>
  );
}

/** Minimal accessible toggle (= styled checkbox). Same visual language
 *  as the existing accent-soft pills — square knob with check when on. */
function Toggle({
  checked,
  onChange,
  "aria-label": ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onChange}
      className={cn(
        "relative inline-flex items-center",
        "w-10 h-5 rounded-full",
        "transition-colors cursor-pointer",
        checked ? "bg-accent" : "bg-bg-hover",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5",
          "w-4 h-4 rounded-full bg-bg shadow-sm",
          "transition-transform",
          checked && "translate-x-5",
        )}
      />
    </button>
  );
}
