"use client";

import * as React from "react";
import { Bell, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useUnreadNotifications } from "@/lib/realtime/use-unread-notifications";
import {
  fetchNotifications,
  type NotificationItem,
} from "@/lib/api";
import { clearAllNotifications, clearNotification } from "@/lib/actions";
import { createClient } from "@/lib/supabase/client";
import { NotificationRow } from "@/components/notifications/notification-row";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChanged } from "@/lib/use-changed";

/**
 * Topbar bell — the single notification surface.
 *
 * Click → opens a popover dropdown (Gmail / Slack / Notion convention)
 * with the user's recent notifications. No `/notifications` page; the
 * popover IS the system. Clicking a row marks it read and deep-links
 * to the source content (story / folder / etc.) — never to the popover
 * itself.
 *
 * State machine:
 *   - mounted, closed   : just renders the bell + badge from unreadCount
 *   - open, loading     : popover open, first fetch in flight
 *   - open, loaded      : list rendered, mark-as-read inline
 *   - any state, broadcast `notification:new` arrives → bump badge AND
 *                          (if open) prepend new items to the list
 *
 * Returns null when no slug — keeps the bell out of anon surfaces.
 */
export function NotifBell({ slug }: { slug: string | null }) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const { unreadCount, refetch: refetchUnread } = useUnreadNotifications(slug);

  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationItem[]>([]);
  const [nextBeforeId, setNextBeforeId] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [clearingAll, setClearingAll] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);

  const wrapRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click + Escape.
  React.useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Load the first page on each open so the user sees fresh state
  // (avoids "I read the email then opened the bell, why is it unread?").
  // Opening the popover is what puts it in a loading state, so that is
  // decided at render time. The background refresh on broadcast
  // deliberately does not — it should not flash a spinner over a list
  // the user is reading.
  if (useChanged(open) && open) setLoading(true);

  /** Fetch the first page. Touches no React state, so the effect below
   *  can update state only from inside a promise callback. Returns null
   *  when there is nobody to fetch for. */
  const fetchFirstPage = React.useCallback(async () => {
    if (!slug) return null;
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    return fetchNotifications(session.access_token);
  }, [slug]);

  /** Apply a fetched page. Shared by the open-the-popover effect and
   *  the broadcast handler, so the two cannot drift apart. */
  const applyFirstPage = React.useCallback(
    (page: Awaited<ReturnType<typeof fetchFirstPage>>) => {
      if (!page) return;
      setItems(page.notifications);
      setNextBeforeId(page.next_before_id);
    },
    [],
  );

  const loadFirstPage = React.useCallback(async () => {
    try {
      applyFirstPage(await fetchFirstPage());
    } catch (err) {
      console.warn("[NotifBell] fetch failed", err);
    } finally {
      setLoading(false);
    }
  }, [fetchFirstPage, applyFirstPage]);

  // Load on each open, so the list is fresh — someone who read the
  // email then opened the bell should not still see it unread.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchFirstPage()
      .then((page) => {
        if (alive) applyFirstPage(page);
      })
      .catch((err: unknown) => {
        console.warn("[NotifBell] fetch failed", err);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, fetchFirstPage, applyFirstPage]);

  // Live append on broadcast — only matters when the popover is open.
  React.useEffect(() => {
    if (!slug || !open) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`user:${slug}`)
      .on("broadcast", { event: "notification:new" }, () => {
        loadFirstPage();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [slug, open, loadFirstPage]);

  /* ── Clear flows ──
   *  Notifications are dismiss-on-handle: clicking a row deep-links AND
   *  removes that notification from the inbox (Gmail / Slack style).
   *  "Tout effacer" wipes everything in one DELETE. Both are optimistic
   *  with rollback on failure. */
  const clearOne = React.useCallback(async (id: number) => {
    const snapshot = items;
    setItems((prev) => prev.filter((n) => n.id !== id));
    try {
      await clearNotification(id);
      refetchUnread();
    } catch (err) {
      console.warn("[NotifBell] clear failed", err);
      setItems(snapshot);
    }
  }, [items, refetchUnread]);

  const clearAll = React.useCallback(async () => {
    if (items.length === 0 || clearingAll) return;
    setClearingAll(true);
    const snapshot = items;
    const snapshotNext = nextBeforeId;
    setItems([]);
    setNextBeforeId(null);
    try {
      await clearAllNotifications();
      refetchUnread();
    } catch (err) {
      console.warn("[NotifBell] clear-all failed", err);
      setItems(snapshot);
      setNextBeforeId(snapshotNext);
    } finally {
      setClearingAll(false);
      setConfirmClear(false);
    }
  }, [items, nextBeforeId, clearingAll, refetchUnread]);

  /* ── Pagination ── */
  const loadMore = React.useCallback(async () => {
    if (!nextBeforeId || loadingMore || !slug) return;
    setLoadingMore(true);
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const page = await fetchNotifications(session.access_token, nextBeforeId);
      setItems((prev) => [...prev, ...page.notifications]);
      setNextBeforeId(page.next_before_id);
    } catch (err) {
      console.warn("[NotifBell] load more failed", err);
    } finally {
      setLoadingMore(false);
    }
  }, [nextBeforeId, loadingMore, slug]);

  if (!slug) return null;

  const hasUnread = unreadCount > 0;
  const label = hasUnread
    ? t("unreadCount", { count: unreadCount })
    : t("noUnread");
  const badgeText = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className={cn(
          "relative inline-flex items-center justify-center",
          "w-8 h-8 rounded-md",
          "transition-colors",
          open
            ? "bg-bg-hover text-text"
            : hasUnread
              ? "text-accent-text hover:bg-bg-hover"
              : "text-text-3 hover:text-text hover:bg-bg-hover",
        )}
      >
        <Bell
          size={16}
          strokeWidth={hasUnread ? 1.9 : 1.7}
          fill={hasUnread ? "currentColor" : "none"}
          aria-hidden
        />
        {hasUnread && (
          <span
            aria-hidden
            className={cn(
              "absolute -top-0.5 -right-0.5",
              "min-w-[16px] h-[16px] px-1 rounded-full",
              "bg-accent text-bg",
              "text-[9.5px] font-semibold leading-[16px] text-center",
              "tabular-nums",
              "ring-2 ring-bg-elev",
            )}
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t("title")}
          className={cn(
            "absolute top-full right-0 mt-1 z-50",
            "w-[380px] max-w-[calc(100vw-32px)]",
            "bg-bg-elev border border-border rounded-md shadow-lg",
            "flex flex-col",
            "max-h-[70vh]",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border shrink-0">
            <span className="text-[12px] font-semibold text-text">
              {t("title")}
            </span>
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              disabled={items.length === 0 || clearingAll}
              className={cn(
                "inline-flex items-center gap-1.5",
                "text-[11px] font-medium px-2 py-1 rounded-md",
                "transition-colors",
                items.length === 0 || clearingAll
                  ? "text-text-4 cursor-not-allowed"
                  : "text-accent-text hover:bg-bg-hover cursor-pointer",
              )}
            >
              <Trash2 size={11} strokeWidth={1.9} />
              {t("clearAll")}
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="text-center text-[12px] text-text-4 italic py-8">
                {t("loading")}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center text-[12px] text-text-3 italic py-10">
                {t("empty")}
              </div>
            ) : (
              <>
                {items.map((n) => (
                  <NotificationRow
                    key={n.id}
                    notification={n}
                    onClick={() => {
                      clearOne(n.id);
                      setOpen(false);
                    }}
                    locale={locale}
                  />
                ))}
                {nextBeforeId !== null && (
                  <div className="text-center py-2 border-t border-border">
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className={cn(
                        "text-[11.5px] font-medium",
                        loadingMore
                          ? "text-text-4 cursor-not-allowed"
                          : "text-text-2 hover:text-text hover:underline cursor-pointer",
                      )}
                    >
                      {loadingMore ? t("loading") : t("loadMore")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Confirm dialog for "Tout effacer" — same UX language as the Watch
       *  mark-all dialog so users learn one destructive-confirm pattern. */}
      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="!max-w-[440px] w-[min(440px,calc(100vw-32px))] flex flex-col gap-0 p-0">
          <DialogHeader className="px-5 py-4 border-b border-border space-y-1">
            <DialogTitle className="text-[15px] font-semibold tracking-[-0.01em] text-text">
              {t("clearAllConfirmTitle")}
            </DialogTitle>
            <DialogDescription className="text-[12.5px] text-text-3 leading-snug">
              {t("clearAllConfirmBody", { count: unreadCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="px-5 py-3 border-t border-border flex flex-row items-center gap-2 sm:gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              disabled={clearingAll}
              className="
                text-[12px] font-medium px-3 py-1.5 rounded-md
                text-text-2 hover:bg-bg-hover hover:text-text
                cursor-pointer transition-colors
              "
            >
              {t("clearAllCancel")}
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={clearingAll}
              className={cn(
                "text-[12px] font-semibold px-3 py-1.5 rounded-md transition-colors",
                clearingAll
                  ? "bg-bg-sub text-text-4 cursor-not-allowed"
                  : "bg-hot text-bg hover:brightness-110 cursor-pointer",
              )}
            >
              {t("clearAllConfirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
