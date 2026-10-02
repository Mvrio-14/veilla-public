"use client";

import * as React from "react";
import { useLocale } from "next-intl";
import { Sidebar } from "./sidebar";
import { ListPanel } from "./list-panel";
import { DetailPanel } from "./detail-panel";
import { ViewEditDialog } from "./view-edit-dialog";
import { FolderPickerDialog } from "./folder-picker-dialog";
import { useStoryShare } from "@/lib/use-story-share";
import { aggregate, buildUnreadLookup } from "@/lib/aggregate";
import { fromServerAggs } from "@/lib/server-aggs";
import { fromWatchAggregations } from "@/lib/watch-aggs-adapter";
import { useViewCounts, useWatchAggs, useWatchPage } from "@/lib/use-watch";
import { watchQueryHash, type WatchQueryInputs } from "@/lib/watch-query";
import {
  applyFilters,
  deepFilterByAdvanced,
  emptyAdvanced,
  emptyScope,
  normalizeAdvanced,
  type Advanced,
  type Scope,
  type StoryType,
} from "@/lib/filter";
import {
  addStoryToFolder,
  createFolder,
  createView,
  deleteView,
  followStory,
  ignoreStory,
  markAllStoriesRead,
  markArticleRead,
  markStoryRead,
  removeStoryFromFolder,
  saveStory,
  unfollowStory,
  unignoreStory,
  unsaveStory,
  updateView,
} from "@/lib/actions";
import type { Folder, Story, View, UserState, WatchData } from "@/lib/types";
import { useChanged } from "@/lib/use-changed";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * Fold the sidebar's single-pick `Scope` into the `Advanced` filter set
 * the server expects. Used to build the QueryState that drives both
 * `/watch` and `/watch/aggregations` — drill-down semantics expect the
 * picked entity to be part of the user's active filter set so the
 * server can clear it cleanly when computing the facet's own counts.
 *
 * For `scope.kind === "none"`, returns `adv` unchanged (no allocation).
 */
function mergeScopeIntoAdvanced(adv: Advanced, scope: Scope): Advanced {
  if (scope.kind === "none") return adv;
  const merged: Advanced = { ...adv };
  switch (scope.kind) {
    case "category":         merged.categories       = [...adv.categories,       scope.value]; break;
    case "lang":             merged.langs            = [...adv.langs,            scope.value]; break;
    case "feed":             merged.feeds            = [...adv.feeds,            scope.value]; break;
    case "country":          merged.countries        = [...adv.countries,        scope.value]; break;
    case "subject_country":  merged.subjectCountries = [...adv.subjectCountries, scope.value]; break;
    case "person":           merged.persons          = [...adv.persons,          scope.value]; break;
    case "org":              merged.orgs             = [...adv.orgs,             scope.value]; break;
    case "place":            merged.places           = [...adv.places,           scope.value]; break;
    case "event":            merged.events           = [...adv.events,           scope.value]; break;
    case "market":           merged.markets          = [...adv.markets,          scope.value]; break;
    case "product":          merged.products         = [...adv.products,         scope.value]; break;
  }
  return merged;
}


/**
 * Client-side wrapper around sidebar + list + detail.
 *
 * Owns:
 *  - active story id (kept in sync with the URL via `?story=X` so deep-
 *    linking, browser back/forward, and copy-pasting the address bar
 *    all behave like a pro reader app — Feedly / Linear pattern)
 *  - filter state
 *  - aggregations memoized from data
 *
 * URL semantics: `?story=X` carries which cluster's detail panel is
 * currently open. On landing with the param, the panel auto-opens.
 * Closing the panel drops the param. Clicking another story replaces
 * it. The story_id alone is enough — we look it up in the loaded
 * `/watch` payload; if it's not there (stale URL, story since purged,
 * etc.) the panel stays closed silently.
 */

/** The five orthogonal slots the Watch header can be in. */
type ViewMode = "all" | "unread" | "saved" | "top" | "ignored";

/** UI state Watch keeps in sessionStorage between navigations. */
type PersistedWatchState = Partial<{
  advanced: Advanced;
  scope: Scope;
  view: ViewMode;
  currentViewId: string | null;
  storyType: StoryType;
}>;

/** Read the persisted state, or null if there is none to read.
 *
 *  Never throws: bad JSON, a full quota and blocked storage all mean
 *  the same thing to the caller — start from the defaults. */
function readPersistedWatchState(key: string): PersistedWatchState | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PersistedWatchState) : null;
  } catch (err) {
    console.warn("[watch] failed to hydrate persisted state", err);
    return null;
  }
}

export function WatchMain({
  data: initialData,
  storyIdFromUrl,
  viewIdFromUrl,
}: {
  data: WatchData;
  /** The `?story=X` value parsed from the URL by the server component.
   *  Seeds `activeStoryId` on mount so the detail panel auto-opens on
   *  landing. Null when no `?story=` is present. */
  storyIdFromUrl?: number | null;
  /** The `?view=Y` value parsed from the URL. When present, wins over
   *  sessionStorage at mount/navigation — the user is following an
   *  explicit deep-link (typically a shared-view notification) and
   *  must land inside the requested view regardless of where they
   *  were last time. Null when no `?view=` is present. */
  viewIdFromUrl?: string | null;
}) {
  const isOwner = initialData.viewer?.is_owner ?? false;
  const locale = useLocale();

  /* ── Pagination state ──
   *
   * `initialData` is the SSR-rendered first page (= `data` prop). The
   * SPA accumulates subsequent pages locally and overrides
   * stories/singletons via the `data` memo below — everything
   * downstream (filters, aggs, action handlers) sees the merged stream.
   *
   * Changing tabs (= new stream identity) resets accumulated and
   * refetches with the new `item_type` param.
   *
   * Fixed state (views, folders, preferences, universe, aggs_server)
   * is owned by `initialData` — the API only ships these
   * on `is_initial_page` responses. */
  type ServerItemType = "all" | "communs" | "originaux";
  const [accumulated, setAccumulated] = React.useState<{
    stories: WatchData["stories"];
    singletons: WatchData["singletons"];
    cursor: string | null;
  }>(() => ({
    stories:    initialData.stories,
    singletons: initialData.singletons,
    cursor:     initialData.next_cursor ?? null,
  }));
  const [isLoadingNext, setIsLoadingNext] = React.useState(false);

  /* Re-hydrate accumulated state when a fresh SSR fetch lands. The
   * trigger could be:
   *   - user navigates away and back
   *   - the "X nouveaux articles" pill click (`router.refresh()`)
   *   - prefs / window_hours change triggers a refetch
   *   - anything else that re-runs the server component
   *
   * We detect "actually fresh data" via reference identity on
   * `initialData.stories` — Next.js produces a new array reference per
   * server render, but local state mutations (handleLoadMore appending
   * to `accumulated`) leave `initialData` untouched, so we never
   * accidentally wipe accumulated mid-pagination.
   *
   * The SSR fetch always uses `?item_type=all`; the sync effect on
   * `storyType` below re-applies the user's persisted tab choice right
   * after, in one additional refetch (a brief sub-second flicker).
   *
   * StrictMode (dev only): React double-invokes effects on mount, so
   * the initial setAccumulated runs twice. Both produce the same
   * downstream state — harmless, just a wasted re-render in dev. */
  const lastInitialStoriesRef = React.useRef(initialData.stories);
  React.useEffect(() => {
    if (lastInitialStoriesRef.current === initialData.stories) return;
    lastInitialStoriesRef.current = initialData.stories;
    setAccumulated({
      stories:    initialData.stories,
      singletons: initialData.singletons,
      cursor:     initialData.next_cursor ?? null,
    });
  }, [initialData.stories, initialData.singletons, initialData.next_cursor]);

  /* Effective `data` for the rest of the component. Fixed-state fields
   * come from `initialData` (= stable across pages of one session);
   * stories/singletons come from the accumulated stream, so downstream
   * code reads one merged `data.stories`. */
  const data = React.useMemo<WatchData>(() => ({
    ...initialData,
    stories:    accumulated.stories,
    singletons: accumulated.singletons,
  }), [initialData, accumulated.stories, accumulated.singletons]);

  /* ── Active story / article (client state) ──
   * `activeStoryId` drives the cluster's accordion expand in the list
   * AND the detail panel's selected cluster. Synced with the URL via
   * `?story=X` so deep-linking, refresh and copy-paste behave like a
   * pro reader. Seeded on mount from `storyIdFromUrl` so the panel
   * auto-opens on landing when the URL carries a story_id.
   *
   * `activeArticleId` overrides the detail panel when set: clicking an
   * article row inside an expanded cluster previews it in the panel
   * (image + summary + "Lire l'article") instead of navigating right
   * away. It's cleared on every change of cluster or panel close so
   * the panel stays coherent with what the user just clicked. */
  const [activeStoryId, setActiveStoryId] = React.useState<number | null>(
    storyIdFromUrl ?? null,
  );
  const [activeArticleId, setActiveArticleId] = React.useState<number | null>(
    null,
  );

  /* ── URL sync ──
   * Mirror `activeStoryId` into `?story=X` via shallow replaceState —
   * no Next.js navigation, no re-render, just the address bar updated.
   * `replaceState` (vs `pushState`) so each click doesn't pollute the
   * browser history with a new entry — the user expects Back to return
   * to where they were before opening Veilla, not step through every
   * story they previewed.
   *
   * Guard: only run when `window` is defined (client only) and when the
   * URL actually needs to change — avoids churning history on no-op
   * renders. */
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("story");
    const target = activeStoryId !== null ? String(activeStoryId) : null;
    if (current === target) return;
    if (target !== null) {
      url.searchParams.set("story", target);
    } else {
      url.searchParams.delete("story");
    }
    window.history.replaceState(null, "", url.toString());
  }, [activeStoryId]);

  /* ── Read state (optimistic) ──
   * Tracks stories the user just opened in this session — they instantly
   * lose their unread/updated marker, even before the next /watch refetch
   * picks up the persisted read_at. Owner-only. */
  const [locallyRead, setLocallyRead] = React.useState<Set<number>>(
    () => new Set(),
  );

  /* ── Per-article "new" indicator ──
   * Every article in any cluster starts as "new" (blue dot in the expand).
   * It loses the dot when the user either:
   *   - clicks the article (opens the link), or
   *   - closes the cluster — every article inside is consumed at once,
   *     whether the user clicked them or not. Closing covers the re-click
   *     toggle, switching to another story, hitting X on the detail panel,
   *     and the auto-close on view changes.
   *
   * Hydrated from the server on mount (`data.read_article_ids`) so dots
   * persist across refreshes. Each consume is also pushed back to the
   * server fire-and-forget — local state stays the source of truth for
   * the visible UI, server keeps a durable record. */
  const [consumedArticles, setConsumedArticles] = React.useState<Set<number>>(
    () => new Set(data.read_article_ids ?? []),
  );

  // Re-hydrate when the watch payload changes (server refetch). Drops any
  // articles no longer in the read set — though in practice the server only
  // adds, so the union is monotonic in steady-state.
  // The hook is called unconditionally — `isOwner` gates the update,
  // never the call.
  const readIdsChanged = useChanged(data.read_article_ids);
  if (isOwner && readIdsChanged) {
    setConsumedArticles((prev) => {
      const incoming = data.read_article_ids ?? [];
      const next = new Set(prev);
      let changed = false;
      for (const id of incoming) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }

  const consumeArticles = React.useCallback(
    (ids: Iterable<number>) => {
      const idsArr = Array.from(ids);
      if (idsArr.length === 0) return;
      const fresh: number[] = [];
      setConsumedArticles((prev) => {
        const next = new Set(prev);
        for (const id of idsArr) {
          if (!next.has(id)) {
            next.add(id);
            fresh.push(id);
          }
        }
        return fresh.length > 0 ? next : prev;
      });
      // Persist only the IDs we hadn't already recorded — avoids spamming
      // the API with no-op writes when the user re-opens then closes a
      // cluster whose articles are all consumed already.
      if (fresh.length > 0 && isOwner) {
        Promise.all(fresh.map((id) => markArticleRead(id))).catch((err) => {
          console.error("article-read persist failed", err);
        });
      }
    },
    [isOwner],
  );

  const consumeStoryArticles = React.useCallback(
    (storyId: number) => {
      const story = data.stories.find(
        (s) => s.articles[0]?.story_id === storyId,
      );
      if (!story) return;
      // Opening the card shows every article, so all of them are seen.
      consumeArticles(story.articles.map((a) => a.id));
    },
    [data.stories, consumeArticles],
  );

  const handleArticleConsume = React.useCallback(
    (articleId: number) => consumeArticles([articleId]),
    [consumeArticles],
  );

  const handleArticlePreview = React.useCallback((articleId: number) => {
    setActiveArticleId(articleId);
  }, []);

  const toggleStory = React.useCallback(
    (storyId: number) => {
      setActiveStoryId((current) => {
        const wasOpen = current === storyId;
        // Closing this story (re-click) OR switching to another → mark
        // every article in the leaving cluster as consumed.
        if (wasOpen) {
          consumeStoryArticles(storyId);
        } else if (current !== null) {
          consumeStoryArticles(current);
        }
        return wasOpen ? null : storyId;
      });
      // Switching clusters (or closing) always resets the per-article
      // preview — the panel falls back to the cluster view on open.
      setActiveArticleId(null);

      // Open OR re-open both count as "seen" — fire-and-forget. Server
      // upserts read_at = NOW(), which collapses both is_unread and
      // has_update on the next render.
      if (isOwner) {
        setLocallyRead((prev) => {
          if (prev.has(storyId)) return prev;
          const next = new Set(prev);
          next.add(storyId);
          return next;
        });
        markStoryRead(storyId).catch((err) => {
          console.error("mark-as-read failed", err);
        });
      }
    },
    [isOwner, consumeStoryArticles],
  );

  const closeStory = React.useCallback(() => {
    setActiveStoryId((current) => {
      if (current !== null) consumeStoryArticles(current);
      return null;
    });
    setActiveArticleId(null);
  }, [consumeStoryArticles]);

  /* ── Pagination fetch wiring ──
   *
   * Fetching is owned by the `useWatchPage` hook, which guards against
   * stale responses with its own AbortController + debounce. The hook
   * calls `_mergeReadIds` via the bridge effect to keep client-side dots
   * fresh as new pages arrive. */
  const _mergeReadIds = React.useCallback(
    (ids: number[] | undefined) => {
      if (!isOwner || !ids || ids.length === 0) return;
      setConsumedArticles((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of ids) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [isOwner],
  );

  /* handleLoadMore is provided by `useWatchPage` (see
   * below, after the filter state declarations). We declare a forward
   * ref here that the hook fills in once it's been called; the value is
   * read by the ListPanel via the `handleLoadMore` callback further
   * down. Keeping the ref hop avoids hoisting the hook above all the
   * state declarations the hook's inputs depend on. */
  const loadMoreRef = React.useRef<() => void>(() => {});
  const handleLoadMore = React.useCallback(() => loadMoreRef.current(), []);

  /* ── ViewMode / Scope / SavedView / Advanced / StoryType — five orthogonal slots ──
   *
   *   view            : Tout / Non lus / Sauvegardés / Ignorées (per-user state)
   *   scope           : sidebar Explore single-pick (Trump, FR, Économie, …)
   *   currentViewId   : active saved-view id (the view's `criteria` is
   *                     also written into `advanced`)
   *   advanced        : filter dialog state (period, keywords, multi-cat, …)
   *                     when a saved view is active, mirrors its criteria
   *   storyType       : Tous / Communs / Originaux (list-panel tab)
   *
   * **Sidebar is single-anchor**: view, scope, and saved view are ALL mutex
   * with each other. The user is either in a view-mode (Non lus / Sauvegardés /
   * Ignorées), in a sidebar Explore scope, in a saved view, or in "Tout"
   * (the neutral default). Clicking any sidebar item switches anchor and
   * resets the other two. Compositions live in the dialog (advanced filters),
   * never between sidebar items.
   *
   * `advanced` is mostly machine-controlled: it's loaded from a saved-view's
   * criteria on entry, reset to emptyAdvanced on exit, and only the user
   * can edit it directly via the dialog when in the neutral "Tout" view.
   * (When in a saved view, "Modifier la vue" edits the view definition
   * instead of advanced ad-hoc state.) */
  const [view, setViewRaw] = React.useState<ViewMode>("all");
  const [scope, setScopeRaw] = React.useState<Scope>(emptyScope);
  const [currentViewId, setCurrentViewIdRaw] =
    React.useState<string | null>(null);
  // Saved views live here (declared early so `pageInputs` can read
  // the active view's `criteria_text` for the Boolean short-circuit).
  // Mutated by handleViewSubmit + handleViewDelete below.
  const [views, setViews] = React.useState<View[]>(data.views ?? []);

  /** User's persistent default filters from /watch payload. Seeds the
   *  neutral `advanced` state (= the user's editorial scope applied on
   *  top of "Tout"). Saved views, scopes, and view-modes override these
   *  with their own filter state.
   *
   *  Memoized so callbacks that depend on it (setView / setScope /
   *  setCurrentView / resetScopeAndView) keep stable identities across
   *  renders — otherwise every parent re-render would tear down the
   *  child's React state via prop changes. */
  const userPrefs: Advanced = React.useMemo(
    // normalizeAdvanced fills any field missing from a pre-schema-change
    // payload (e.g. older users.preferences saved before subjectCountries
    // / articleTypes existed). Without it, `advancedIsActive` crashes on
    // `.length` of undefined when /watch first hydrates.
    () => normalizeAdvanced(data.preferences),
    [data.preferences],
  );
  const [advanced, setAdvanced] = React.useState<Advanced>(userPrefs);
  const [storyType, setStoryType] = React.useState<StoryType>("all");
  // Global SPA period selector: the single source of truth for the time
  // window across the whole /watch surface — story list body + sidebar
  // view badges + entity/feed counters. `advanced.periodMinutes` is
  // ignored (see src/retention.py + src/watch_query.py). Initialised from
  // the SSR window_hours so a hard refresh keeps whatever the server chose.
  const [periodHours, setPeriodHours] = React.useState<number>(
    initialData.window_hours || 24,
  );
  const viewIgnored = view === "ignored";

  /* ── Server-driven page hook ──
   *
   * `useWatchPage` owns the refetch lifecycle: any change to the inputs
   * (advanced filters, sidebar scope pick, tab, view-mode, period
   * window) cancels in-flight requests, debounces 250ms, then refetches
   * the first page with the new filter set. `loadMore()` extends with
   * the next cursor.
   *
   * Why a bridge to `accumulated` rather than direct consumption:
   * downstream code reads `data.stories` from the accumulated state, and
   * mirroring hook.data → setAccumulated keeps a single data path for
   * both the first page and the pages appended by `loadMore()`.
   *
   * The effective tab (Tous / Communs / Originaux) accounts for the
   * "top" view-mode overlay — clicking "À la une" forces the server
   * stream to clusters only, even though the visual tab indicator
   * stays on the user's underlying choice.
   */
  const effectivePageType: ServerItemType =
    view === "top" ? "communs" : storyType;

  const pageInputs = React.useMemo<WatchQueryInputs>(() => {
    const advWithScope = mergeScopeIntoAdvanced(advanced, scope);
    // When the active saved view was composed in Boolean mode, ship
    // its Lucene string as `criteriaText` — the backend resolver
    // short-circuits to the compiled WHERE and skips the per-field
    // arms. The per-field `advanced` values are kept in the payload
    // anyway because the SPA's local filter logic still reads them
    // (e.g. for client-side preview reasons); the backend just
    // ignores them when criteriaText is set.
    const activeView = currentViewId
      ? views.find((v) => v.id === currentViewId)
      : null;
    const criteriaText = (activeView?.criteria_text ?? "").trim();
    return {
      advanced: advWithScope,
      criteriaText: criteriaText || undefined,
      scope:
        effectivePageType === "communs"   ? "common" :
        effectivePageType === "originaux" ? "original" :
                                             "all",
      quickFilter:
        view === "unread" || view === "saved" || view === "ignored"
          ? view
          : "all",
      // The top-level period selector wins over `advanced.periodMinutes`,
      // which stays in the type for the saved-view payload shape but has
      // no effect on filtering.
      periodHours,
      includeClosed: false,
    };
  }, [advanced, scope, effectivePageType, view, periodHours,
      currentViewId, views]);

  /* Hash that matches the SSR payload's filter set (= defaults: no
   * advanced filters, "all" tabs, period = SSR window_hours). When the
   * user's first render produces this exact hash, the hook skips the
   * initial refetch and serves `initialData` straight to its consumers.
   * Any user interaction that changes the hash — including a period
   * selector click — triggers a real fetch. */
  const initialPageHash = React.useMemo(
    () =>
      watchQueryHash({
        advanced:     emptyAdvanced,
        scope:        "all",
        quickFilter:  "all",
        periodHours:  initialData.window_hours,
        includeClosed: false,
      }),
    [initialData.window_hours],
  );

  const pageHook = useWatchPage(
    isOwner ? initialData.slug : null,
    pageInputs,
    {
      enabled:     isOwner,
      initialData,
      initialHash: initialPageHash,
      itemType:    effectivePageType,
    },
  );

  /* Wire the hook's loadMore into the ref the early-declared
   * `handleLoadMore` reads from.
   *
   * After commit rather than during render: a render React discards
   * would otherwise leave the ref holding a callback from work that
   * never happened. `handleLoadMore` only fires from a scroll, which
   * is always after a commit, so it never reads a stale one. */
  React.useEffect(() => {
    loadMoreRef.current = pageHook.loadMore;
  }, [pageHook.loadMore]);

  /* Bridge: mirror hook data into the `accumulated` state so the rest of
   * the component (data memo + filtered memo + consumers) sees fresh
   * content through a single data path. */
  const pageDataChanged = useChanged(pageHook.data);
  if (pageDataChanged && pageHook.data) {
    setAccumulated({
      stories:    pageHook.data.stories,
      singletons: pageHook.data.singletons,
      cursor:     pageHook.data.next_cursor ?? null,
    });
    _mergeReadIds(pageHook.data.read_article_ids);
  }
  if (useChanged(pageHook.isLoadingMore)) {
    setIsLoadingNext(pageHook.isLoadingMore);
  }

  /* ── Persistence across navigation ──
   *
   * Watch UI state (advanced + scope + view + currentViewId + storyType)
   * lives in sessionStorage so navigating to /library or /settings and
   * back doesn't blow away the user's current filter context. Survives
   * refresh too (same tab). Wiped on tab close.
   *
   * Why not localStorage: cross-tab desync is more confusing than
   * cross-session loss. Each tab keeps its own working context.
   *
   * Why not URL params: would bloat the address bar and create stale-
   * link risks when prefs/views change in the DB. SessionStorage stays
   * private to the runtime.
   *
   * # Why the restore happens during render, not in an effect
   *
   * Effects run after a commit, in declaration order. A restore effect
   * calling a handful of setStates would race the save effect, which —
   * firing after the same commit — still holds the *initial* closure
   * values and would write the defaults straight back over
   * sessionStorage (and Strict mode's second restore would then read
   * the corrupted entry), so state would "reset" on every navigation.
   *
   * Restoring during render removes that window entirely. The values and
   * the `isHydrated` flag land in the same pass, so by the time the
   * save effect runs it can only see restored state. The flag still
   * gates the save, as a statement of fact rather than a race to win. */
  const persistKey = `veilla:watch-state:${data.slug}`;
  const browserReady = useHydrated();
  const [isHydrated, setIsHydrated] = React.useState(false);

  if (browserReady && !isHydrated) {
    setIsHydrated(true);
    const persisted = readPersistedWatchState(persistKey);
    if (persisted) {
      // normalize: sessionStorage may hold a pre-schema-change Advanced.
      if (persisted.advanced) setAdvanced(normalizeAdvanced(persisted.advanced));
      if (persisted.scope) setScopeRaw(persisted.scope);
      if (persisted.view) setViewRaw(persisted.view);
      if (persisted.currentViewId !== undefined) {
        setCurrentViewIdRaw(persisted.currentViewId);
      }
      if (persisted.storyType) setStoryType(persisted.storyType);
    }
  }

  React.useEffect(() => {
    if (!isHydrated) return;
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(
        persistKey,
        JSON.stringify({ advanced, scope, view, currentViewId, storyType }),
      );
    } catch {
      // Quota exceeded or blocked — best-effort, drop silently.
    }
  }, [
    isHydrated,
    advanced,
    scope,
    view,
    currentViewId,
    storyType,
    persistKey,
  ]);

  /** Re-seed advanced from prefs when the /watch payload's preferences
   *  change AND the user is currently in the neutral "Tout" state. Lets
   *  a Save in /settings/preferences propagate live after router.refresh
   *  without clobbering an in-progress saved view or ad-hoc dialog edit.
   *
   *  Keyed on the serialised preferences rather than the object, so a
   *  re-render that merely rebuilds an identical `userPrefs` does not
   *  count as a change. */
  const prefsKey = JSON.stringify(normalizeAdvanced(data.preferences));
  const prefsChanged = useChanged(prefsKey);
  if (prefsChanged) {
    const isNeutral =
      view === "all" && scope.kind === "none" && currentViewId === null;
    if (isNeutral) setAdvanced(normalizeAdvanced(data.preferences));
  }

  /** Saved views are client-side stateful — mutations (create / update /
   *  delete) update this immediately, so the sidebar reflects the new state
   *  without waiting for a /watch refetch. The server is still the source
   *  of truth on mount and on external refresh (e.g., another tab) — we
   *  re-sync from data.views whenever the prop changes.
   *
   *  Note: the actual `useState` is declared earlier (near `currentViewId`)
   *  so that `pageInputs` can read the active view's `criteria_text` for
   *  the Boolean short-circuit. The line below just keeps it in sync
   *  with the server-side prop.
   *
   *  The comparison is on `data.views` itself, before the `?? []`
   *  fallback: that fallback builds a fresh array on every render, and
   *  comparing against it would report a change every time. */
  if (useChanged(data.views)) setViews(data.views ?? []);

  /** Manual folders — same client-side pattern as `views`. The
   *  `story_count` on each folder is server-computed; we increment /
   *  decrement it optimistically when adding/removing membership. */
  const [folders, setFolders] = React.useState<Folder[]>(data.folders ?? []);
  if (useChanged(data.folders)) setFolders(data.folders ?? []);

  const setView = React.useCallback((next: ViewMode) => {
    setViewRaw(next);
    if (next !== "all") {
      // Mutex: entering a non-default view clears any scope, saved view,
      // and ad-hoc advanced. The user picked a single anchor — the prefs
      // baseline still applies on top.
      setScopeRaw(emptyScope);
      setCurrentViewIdRaw(null);
      setAdvanced(userPrefs);
    } else {
      // Returning to "Tout" → snap back to the user's prefs baseline.
      setAdvanced(userPrefs);
    }
  }, [userPrefs]);

  const setScope = React.useCallback((next: Scope) => {
    setScopeRaw(next);
    if (next.kind !== "none") {
      // Mutex: scope replaces view + saved view + advanced — prefs
      // baseline still applies on top of the scope.
      setViewRaw("all");
      setCurrentViewIdRaw(null);
      setAdvanced(userPrefs);
    }
  }, [userPrefs]);

  const setCurrentView = React.useCallback(
    (viewId: string | null) => {
      setCurrentViewIdRaw(viewId);
      if (viewId !== null) {
        // Mutex: saved view replaces view + scope, and loads its
        // criteria into advanced. Saved views explicitly ignore the
        // user's preferences (= curated lens, not editorial defaults).
        setViewRaw("all");
        setScopeRaw(emptyScope);
        const v = views.find((x) => x.id === viewId);
        // normalizeAdvanced fills in fields that older saved-view
        // criteria might lack (e.g. articleTypes added after creation).
        setAdvanced(normalizeAdvanced(v?.criteria));
      } else {
        // Leaving a saved view explicitly (toggle off): the user is
        // back in "Tout" — re-apply their preference baseline.
        setAdvanced(userPrefs);
      }
    },
    [views, userPrefs],
  );

  const resetScopeAndView = React.useCallback(() => {
    setScopeRaw(emptyScope);
    setViewRaw("all");
    setCurrentViewIdRaw(null);
    setAdvanced(userPrefs);
  }, [userPrefs]);

  /* ── currentViewId ↔ URL sync ──
   * Mirror of the `activeStoryId ↔ ?story=X` sync above, for the
   * `?view=Y` param. When the user enters / leaves a saved view via
   * the sidebar, the URL stays authoritative — copy-paste the address
   * bar reconstructs the same filter context. Same `replaceState`
   * (not push) discipline so back-button doesn't step through every
   * view toggle. */
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("view");
    const target = currentViewId;
    if (current === target) return;
    if (target !== null) {
      url.searchParams.set("view", target);
    } else {
      url.searchParams.delete("view");
    }
    window.history.replaceState(null, "", url.toString());
  }, [currentViewId]);

  /* ── URL → state override (view deep-link) ──
   * When the user lands with `?view=X`, that explicit intent wins
   * over whatever was in sessionStorage (e.g. they were in vue Y last
   * time but clicked a notification for vue X — they must land in X).
   *
   * Gated by `isHydrated` so the sessionStorage hydration finishes
   * first, then this layers on top. Also re-fires on `viewIdFromUrl`
   * change — clicking a different notif while already on /watch
   * triggers a soft-navigation that updates the prop and we re-apply.
   *
   * # The ref dance
   *
   * We MUST distinguish "the URL changed via navigation" from "state
   * changed via sidebar click" — both trigger a re-render but only the
   * first should drive new state. Without a ref, the state-to-URL
   * sync below writes `?view=` via `replaceState` (which doesn't re-
   * run the server component, so `viewIdFromUrl` prop stays stale),
   * the override fires because `currentViewId` changed and the prop
   * doesn't match, and we'd revert the user's click. Tracked the last
   * applied URL value in `lastAppliedViewIdFromUrlRef` and only act
   * when the prop genuinely differs from what we last applied.
   *
   * Validation: skip if the view doesn't exist in the user's views.
   * Stale links (deleted view, cross-user link) fall through silently
   * to the user's previous state.
   *
   * The value watched is gated on hydration rather than the branch
   * being gated: a deep link that arrives before the persisted state
   * has been restored would otherwise be seen as "changed" once,
   * skipped, and then never seen again. Folding the gate into the
   * watched value makes hydration itself the change that applies it. */
  const urlViewId = isHydrated ? viewIdFromUrl : undefined;
  const urlViewIdChanged = useChanged(urlViewId);
  if (urlViewIdChanged && urlViewId) {
    // A deleted or cross-user view id is ignored rather than applied.
    const exists = (data.views ?? []).some((v) => v.id === urlViewId);
    if (exists) setCurrentView(urlViewId);
  }

  /* ── URL → state override (story deep-link) ──
   * Same dance as viewIdFromUrl above, applied to `?story=X`.
   *
   * Mounted with `useState(storyIdFromUrl ?? null)`, the initial value
   * only runs once. When the user soft-navigates from /watch (no
   * story) to /watch?story=X via a notif Link, the prop updates but
   * useState doesn't re-init — so the panel never opens. This effect
   * patches that, gated by a ref so state-driven URL writes
   * (toggleStory → URL sync via replaceState) don't fight back.
   *
   * No `isHydrated` gate needed because activeStoryId isn't part of
   * the sessionStorage hydration set (only filter-related state is). */
  const urlStoryIdChanged = useChanged(storyIdFromUrl);
  if (urlStoryIdChanged && storyIdFromUrl !== null && storyIdFromUrl !== undefined) {
    setActiveStoryId(storyIdFromUrl);
    // Clearing the article preview is consistent with how `toggleStory`
    // handles switching clusters — the DetailPanel falls back to the
    // cluster view on open.
    setActiveArticleId(null);
  }

  /* ── Sticky "Non lus" snapshot ──
   *
   * Reeder / Slack / Linear pattern: when you enter the unread view, we
   * capture the set of unread story IDs at that moment. While you stay
   * in this view, those IDs remain visible — even after you click them
   * and they become "read". This way the user can click, read, scroll,
   * without the list shifting under them.
   *
   * The snapshot resets to `null` when leaving the view (so the next
   * entry takes a fresh snapshot of what's still unread). The sidebar
   * count is independent — it always shows the truly-unread total. */
  const [unreadSnapshot, setUnreadSnapshot] = React.useState<Set<number> | null>(
    null,
  );

  /* ── Optimistic overrides ──
   *
   * Map storyId → partial user_state. Wins over the server-fetched flags so
   * the UI reflects an action *before* the next /watch refetch (counts,
   * filters, action buttons all look at this same source of truth).
   *
   * Set by the four handlers below: a click on Save/Ignore writes the
   * partial here, then fires the API in the background. On API failure
   * we roll the override back. */
  const [overrides, setOverrides] = React.useState<
    Map<number, Partial<UserState>>
  >(() => new Map());

  const applyOverride = React.useCallback(
    (storyId: number, partial: Partial<UserState>) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        next.set(storyId, { ...(next.get(storyId) ?? {}), ...partial });
        return next;
      });
    },
    [],
  );

  const effectiveState = React.useCallback(
    (
      sid: number | null | undefined,
      base: UserState | null | undefined,
    ): UserState | null => {
      if (!base) return null;
      if (sid === null || sid === undefined) return base;
      const o = overrides.get(sid);
      let next: UserState = o ? { ...base, ...o } : base;
      // Marking a story as read this session collapses both unread flags —
      // keeps the "Non lus" counter and filter in sync with the dot
      // disappearing on the card.
      if (locallyRead.has(sid)) {
        next = { ...next, is_unread: false, has_update: false };
      }
      return next;
    },
    [overrides, locallyRead],
  );

  /** Save/unsave/ignore/unignore handlers — all share the same shape:
   *  optimistic override → API call → revert on failure.
   *
   *  Save and Folder are independent: saving never touches folder
   *  membership, and unsaving never clears folders. */
  const handleSave = React.useCallback(
    async (storyId: number) => {
      applyOverride(storyId, { saved: true });
      try {
        await saveStory(storyId);
      } catch (err) {
        console.error("save failed", err);
        applyOverride(storyId, { saved: false });
      }
    },
    [applyOverride],
  );

  const handleUnsave = React.useCallback(
    async (storyId: number) => {
      applyOverride(storyId, { saved: false });
      try {
        await unsaveStory(storyId);
      } catch (err) {
        console.error("unsave failed", err);
        applyOverride(storyId, { saved: true });
      }
    },
    [applyOverride],
  );

  const handleIgnored = React.useCallback(
    async (storyId: number) => {
      setActiveStoryId((current) => (current === storyId ? null : current));
      applyOverride(storyId, { ignored: true });
      try {
        await ignoreStory(storyId);
      } catch (err) {
        console.error("ignore failed", err);
        applyOverride(storyId, { ignored: false });
      }
    },
    [applyOverride],
  );

  const handleUnignored = React.useCallback(
    async (storyId: number) => {
      applyOverride(storyId, { ignored: false });
      try {
        await unignoreStory(storyId);
      } catch (err) {
        console.error("unignore failed", err);
        applyOverride(storyId, { ignored: true });
      }
    },
    [applyOverride],
  );

  /** Follow / unfollow — optimistic toggle on `followed` user_state.
   *  Mirrors the save/ignore pattern. Per-channel notification delivery
   *  is the server's job (settings.notif_prefs) — the UI just records
   *  the subscription. */
  const handleFollow = React.useCallback(
    async (storyId: number) => {
      applyOverride(storyId, { followed: true });
      try {
        await followStory(storyId);
      } catch (err) {
        console.error("follow failed", err);
        applyOverride(storyId, { followed: false });
      }
    },
    [applyOverride],
  );

  const handleUnfollow = React.useCallback(
    async (storyId: number) => {
      applyOverride(storyId, { followed: false });
      try {
        await unfollowStory(storyId);
      } catch (err) {
        console.error("unfollow failed", err);
        applyOverride(storyId, { followed: true });
      }
    },
    [applyOverride],
  );

  /* ── Aggregations from raw (unfiltered) data ──
   *
   * Two flavours live side-by-side because the consumers want different
   * things:
   *
   *   `aggs`         — full universe. Feeds the FilterPicker (Advanced
   *                    dialog + view editor): you want to be able to add
   *                    "France" to your filter even if your current
   *                    prefs hide every France-tagged story today.
   *                    Prefers the server-side `data.aggs_server`
   *                    payload when present — same shape, computed once
   *                    on the API side, which saves one full client
   *                    iteration per render. Falls back to client-side
   *                    `aggregate()` if the server didn't populate the
   *                    field (e.g. anon viewer of a public
   *                    watch where aggs_server is null).
   *
   *   `aggsSidebar`  — what's actually visible after the user's current
   *                    Advanced filter (= persistent prefs, or the
   *                    active saved view's criteria). Feeds the Sidebar
   *                    entity sections (Pays concernés, Sujets,
   *                    Personnes, …) so a count of "Cuba 1" really
   *                    means "1 story will appear if you click here".
   *                    Scope is NOT applied (sidebar must still show
   *                    OTHER entities the user could switch to).
   */
  /* ── Live aggregations from /watch/aggregations ──
   *
   * Facets are computed server-side over the FULL universe matching the
   * filter set. A client-side tally over the loaded pages would grow as
   * the user scrolls and narrow against the loaded set rather than the
   * full universe.
   *
   * # Design choice — sidebar shows the UNIVERSE, never the filtered view
   *
   * The sidebar is a navigation surface, not a
   * narrative-context view. It must NEVER move when the user clicks a
   * sidebar item, types in the search bar, picks a tab, or opens a
   * saved view. The counts always reflect the same thing: "what's in
   * your watch right now, period." This rules out Algolia-style
   * drill-down (= each facet narrows when others move), which would
   * break the user-as-navigator model.
   *
   * Implementation: send the hook a stripped QueryState carrying only
   * the period window. All other filter dimensions stay at their
   * defaults (= "no filter"), so the server returns the unrestricted
   * universe.
   *
   * If the SPA later grows a "show me only what I'm reading"-style
   * mini-aggs widget, we add a SECOND useWatchAggs call with the full
   * filter set — the main sidebar keeps its universal contract.
   */
  const sidebarAggsInputs = React.useMemo<WatchQueryInputs>(() => ({
    advanced:     emptyAdvanced,
    scope:        "all",
    quickFilter:  "all",
    // Sidebar aggregations follow the global SPA period selector too —
    // if the user narrows to 1h, the entity/feed/language counts on the
    // sidebar shrink accordingly.
    periodHours,
    includeClosed: false,
  }), [periodHours]);

  const liveAggs = useWatchAggs(
    isOwner ? initialData.slug : null,
    sidebarAggsInputs,
    { enabled: isOwner },
  );

  /* Per-saved-view item counts. Fires
   * /me/views/counts asynchronously after the page mounts — the
   * compute is heavy (10-30s cold) and we never want to block /watch
   * on it. Server caches the result for 60s; subsequent loads are
   * instant. `viewCountsTrigger` bumps after a view CRUD so the
   * sidebar badges refresh without a full page reload. */
  const [viewCountsTrigger, setViewCountsTrigger] = React.useState(0);
  const viewCountsState = useViewCounts(isOwner, viewCountsTrigger, periodHours);
  const viewCounts = viewCountsState.data ?? undefined;

  /* Filter-aware aggs for the LIST-PANEL tab counters (Tous / Communs /
   * Originaux + Non lus / Sauvegardés / Ignorées). Unlike the sidebar
   * aggs above which stay on the universe, these MUST reflect the active
   * search query, scope pick, advanced filters, etc. — they represent
   * "what would I see if I clicked this tab right now?".
   *
   * The server embeds `watch_aggs` in the
   * /watch initial response (= aggs computed for the SAME query_state
   * the page request used). The hook seeds from this when the hash
   * matches and skips the first fetch, so counters paint correct from
   * the very first frame. Subsequent filter changes trigger normal
   * debounced refetches (cached server-side, 60s TTL).
   *
   * The `initialPageHash` was computed above for `useWatchPage`'s SSR
   * skip-check (= defaults: no advanced filters, no tabs, period =
   * window_hours). The server's /watch SSR call uses the same default
   * filter set, so `initialData.watch_aggs` corresponds to that hash. */
  const pageAggs = useWatchAggs(
    isOwner ? initialData.slug : null,
    pageInputs,
    {
      enabled:     isOwner,
      initialData: initialData.watch_aggs ?? null,
      initialHash: initialPageHash,
    },
  );

  const aggs = React.useMemo(() => {
    if (liveAggs.data) {
      return fromWatchAggregations(liveAggs.data, data.universe, locale).aggs;
    }
    if (data.aggs_server) {
      return fromServerAggs(data.aggs_server, locale).aggs;
    }
    return aggregate(data.stories, data.singletons, locale);
  }, [liveAggs.data, data.aggs_server, data.stories, data.singletons, data.universe, locale]);

  // Deep article-level filter: used only when the
  // hook hasn't returned — the server-side drill-down already produces a
  // filter-aware view, so when liveAggs.data is present we don't need
  // the client-side deep filter at all.
  const advancedFiltered = React.useMemo(
    () => deepFilterByAdvanced(data.stories, data.singletons, advanced),
    [data.stories, data.singletons, advanced],
  );

  const aggsSidebar = React.useMemo(() => {
    if (liveAggs.data) {
      // Server already produces a drill-down filter-aware view, no
      // additional client narrowing needed.
      return fromWatchAggregations(liveAggs.data, data.universe, locale).aggs;
    }
    return aggregate(
      advancedFiltered.stories,
      advancedFiltered.singletons,
      locale,
    );
  }, [liveAggs.data, advancedFiltered, data.universe, locale]);

  /* ── Apply scope + advanced + view on top of raw data ──
   *
   * Pipeline (in order):
   *   1. scope + advanced → content-level filters (article fields)
   *   2. view             → per-user state (saved / ignored / unread)
   *
   * View uses the EFFECTIVE state (server flags + optimistic overrides)
   * so clicking save/ignore updates the filtered list immediately, without
   * waiting for the next /watch.
   *
   * "unread" view is special: it uses the sticky snapshot taken when the
   * user entered the view, so reading a story doesn't make it vanish
   * under their cursor. Only ignore still pulls a story out of the
   * snapshot. */
  const filtered = React.useMemo(() => {
    const f = applyFilters(data.stories, data.singletons, scope, advanced);

    const passes = (
      sid: number | null | undefined,
      base: UserState | null | undefined,
    ): boolean => {
      const state = effectiveState(sid, base);
      // Non-owner viewing a public watch: no per-user state, only "all"
      // makes sense (view options are owner-only anyway).
      if (!state) return view === "all";

      switch (view) {
        case "ignored":
          return state.ignored;
        case "saved":
          return state.saved && !state.ignored;
        case "unread":
          if (state.ignored) return false;
          // Sticky: while in the view, the snapshot is the source of truth.
          if (unreadSnapshot && sid !== null && sid !== undefined) {
            return unreadSnapshot.has(sid);
          }
          return state.is_unread || state.has_update;
        case "top":
          // Structural filter (multi-source) is applied after the switch;
          // singletons are dropped entirely. Here we just exclude ignored.
          return !state.ignored;
        case "all":
        default:
          return !state.ignored;
      }
    };

    const stories = f.stories.filter((s) =>
      passes(s.articles[0]?.story_id, s.user_state ?? null),
    );
    const singletons = f.singletons.filter((a) =>
      passes(a.story_id, a.user_state ?? null),
    );

    // "À la une" / Top stories: keep only multi-source clusters (singletons
    // are single-source by construction so they're dropped) and re-sort by
    // distinct source count DESC. Recency is the tie-breaker so within the
    // same coverage level the freshest story bubbles up.
    if (view === "top") {
      const sourceCount = (s: Story) =>
        new Set(s.articles.map((a) => a.source)).size;
      const latestTs = (s: Story) => {
        let max = "";
        for (const a of s.articles) {
          const t = a.published_at || a.fetched_at || "";
          if (t > max) max = t;
        }
        return max;
      };
      const sorted = [...stories].sort((a, b) => {
        const diff = sourceCount(b) - sourceCount(a);
        return diff !== 0 ? diff : latestTs(b).localeCompare(latestTs(a));
      });
      return { stories: sorted, singletons: [] };
    }

    return { stories, singletons };
  }, [
    data.stories,
    data.singletons,
    scope,
    advanced,
    effectiveState,
    view,
    unreadSnapshot,
  ]);

  /** Counts shown next to each quick-filter row.
   *
   * Server-side filter-aware aggregations (`pageAggs`) drive the
   * numbers. They reflect the FULL universe matching the active filter
   * set, not just the loaded pages.
   *
   * When `pageAggs.data` is null (= first paint of
   * a cold-cache session), every field is set to `null` rather than
   * falling back to the client-side tally on the loaded set. Showing
   * "50" because that's the first-page article count would lie about
   * a 524-story universe. The consumers (`NavRow count` props in the
   * Sidebar) already handle null gracefully by hiding the number.
   *
   * Optimistic UX caveat: actions (save / ignore / read) refresh on the
   * next /aggregations roundtrip (250ms debounce + request). Tabs may
   * show a stale count for that brief window — an acceptable trade for
   * counts that cover the whole universe. Stale-while-revalidate keeps the previous values visible
   * during refetch so we never flash "null" once we've had a value.
   */
  const counts = React.useMemo<{
    all:     number | null;
    unread:  number | null;
    saved:   number | null;
    ignored: number | null;
    top:     number | null;
  }>(() => {
    if (pageAggs.data) {
      return {
        all:     pageAggs.data.by_quick_filter.all,
        unread:  pageAggs.data.by_quick_filter.unread,
        saved:   pageAggs.data.by_quick_filter.saved,
        ignored: pageAggs.data.by_quick_filter.ignored,
        // "À la une" = multi-source clusters — same definition as
        // by_scope.common (= stories with >= 2 visible articles in scope).
        top:     pageAggs.data.by_scope.common,
      };
    }
    // No aggregations yet → emit null instead of misleading client-side
    // tallies. The first-page tally would say "50" for "Tous" because
    // that's how many items the SSR shipped, while the real universe
    // count could be hundreds.
    return { all: null, unread: null, saved: null, ignored: null, top: null };
  }, [pageAggs.data]);

  /** "Tout marquer comme lu" — fresh start. Marks EVERY loaded story read,
   *  ignoring the active filter/scope. Optimistic: add all ids to
   *  locallyRead (collapses unread flags + counts via effectiveState) and
   *  empty the sticky "Non lus" snapshot so that view clears at once.
   *  Rolls back both on API failure. Owner-only. */
  const handleMarkAllRead = React.useCallback(() => {
    if (!isOwner) return;
    const ids: number[] = [];
    for (const s of data.stories) {
      const sid = s.articles[0]?.story_id;
      if (typeof sid === "number") ids.push(sid);
    }
    for (const a of data.singletons) {
      if (typeof a.story_id === "number") ids.push(a.story_id);
    }
    if (ids.length === 0) return;

    const prevLocallyRead = locallyRead;
    const prevSnapshot = unreadSnapshot;
    setLocallyRead((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setUnreadSnapshot(new Set());

    markAllStoriesRead(ids).catch((err) => {
      console.error("mark-all-read failed", err);
      setLocallyRead(prevLocallyRead);
      setUnreadSnapshot(prevSnapshot);
    });
  }, [isOwner, data, locallyRead, unreadSnapshot]);

  /* Capture / reset the sticky "Non lus" snapshot.
   *
   * Taken on view transitions only, and deliberately never refreshed
   * while the user stays inside the view — that is what keeps a story
   * on screen as they read it instead of yanking it away.
   *
   * Computed during render rather than after it, so the list is never
   * painted once against the previous view's snapshot. */
  if (useChanged(view)) {
    if (view !== "unread") {
      setUnreadSnapshot(null);
    } else {
      setUnreadSnapshot(captureUnreadSnapshot());
    }
  }

  function captureUnreadSnapshot(): Set<number> {
    const snap = new Set<number>();
    const collect = (
      sid: number | null | undefined,
      base: UserState | null | undefined,
    ) => {
      if (sid === null || sid === undefined) return;
      const state = effectiveState(sid, base);
      if (!state || state.ignored) return;
      if (state.is_unread || state.has_update) snap.add(sid);
    };
    for (const s of data.stories) collect(s.articles[0]?.story_id, s.user_state ?? null);
    for (const a of data.singletons) collect(a.story_id, a.user_state ?? null);
    return snap;
  }

  /* ── Per-Explore-section unread counts ──
   *
   * Drives the blue badge next to each row in the sidebar Explore sections
   * (feeds / origin / subjectCountries / categories / langs / persons /
   * orgs / locations / events / markets / products).
   *
   * Design: build the unread tally by re-running the SAME `aggregate()`
   * pipeline used for totals, on a unread-only narrowing of the universe.
   * That guarantees the two numbers on any row (total + unread) always
   * come from the same data shape and the same dimension definition:
   *   - "Origine" section reads `origin` (= aggregate.originByRegion,
   *     which keys on source_country) for BOTH count and unreadCount.
   *   - "Pays concernés" reads `subject` (= aggregate.subjectCountriesByRegion,
   *     which keys on article.countries) for BOTH.
   *   - … and so on for every other section.
   *
   * Reading a total and an unread count from different dimensions
   * (e.g. `a.countries` vs `a.source_country`) would show impossible
   * pairs such as unread > total. Keeping `aggregate()` as the only
   * place that knows about dimensions also means a new sidebar section
   * needs no matching tally here.
   *
   * Lens & filter discipline: the unread subset is taken from
   * `advancedFiltered` (= the same universe `aggsSidebar` is built from)
   * AFTER applying the unread predicate via `effectiveState`. Stories
   * the user just locally-read drop out via effectiveState wiping
   * is_unread — so badges update live the same render.
   */
  const unreadFiltered = React.useMemo(() => {
    const isUnread = (
      sid: number | null | undefined,
      base: UserState | null | undefined,
    ): boolean => {
      const state = effectiveState(sid, base);
      if (!state || state.ignored) return false;
      return state.is_unread || state.has_update;
    };
    return {
      stories: advancedFiltered.stories.filter((s) =>
        isUnread(s.articles[0]?.story_id, s.user_state ?? null),
      ),
      singletons: advancedFiltered.singletons.filter((a) =>
        isUnread(a.story_id, a.user_state ?? null),
      ),
    };
  }, [advancedFiltered, effectiveState]);

  const aggsUnread = React.useMemo(
    () =>
      aggregate(unreadFiltered.stories, unreadFiltered.singletons, locale),
    [unreadFiltered, locale],
  );

  const unreadCounts = React.useMemo(
    () => buildUnreadLookup(aggsUnread),
    [aggsUnread],
  );

  /* ── Auto-close the detail panel when the active story leaves the
   *    visible list — filters changed, the tab switched, data refreshed.
   *
   *    An invariant, not a reaction: a panel open on a story that is no
   *    longer in the list is never a valid state, so it is corrected
   *    during render rather than one frame later. `closeStory` clears
   *    the id, which makes the condition false on the retry. ── */
  if (activeStoryId !== null) {
    const showClusters = storyType !== "originaux";
    const showSingletons = storyType !== "communs";

    const inStories =
      showClusters &&
      filtered.stories.some(
        (s) => s.articles[0]?.story_id === activeStoryId,
      );
    const inSingletons =
      showSingletons &&
      filtered.singletons.some((a) => a.story_id === activeStoryId);

    if (!inStories && !inSingletons) {
      closeStory();
    }
  }

  /* ── View dialog state + CRUD handlers ──
   * `viewDialog` drives the ViewEditDialog (open + mode + initial value).
   * Create / Update / Delete mutate the local `views` state directly so
   * the sidebar reflects the new state without waiting for any /watch
   * re-fetch. Server is the source of truth on mount + on the next natural
   * refresh (no need for router.refresh() — view changes don't affect
   * the rest of the watch payload). */
  const [viewDialog, setViewDialog] = React.useState<
    | { mode: "create" }
    | { mode: "edit"; view: View }
    | null
  >(null);

  const handleCreateView = React.useCallback(() => {
    setViewDialog({ mode: "create" });
  }, []);

  const handleEditView = React.useCallback(
    (viewId: string) => {
      const v = views.find((x) => x.id === viewId);
      if (v) setViewDialog({ mode: "edit", view: v });
    },
    [views],
  );

  const handleViewSubmit = React.useCallback(
    async (payload: {
      name: string;
      criteria: Advanced;
      criteriaText: string | null;
    }) => {
      try {
        if (viewDialog?.mode === "create") {
          const created = await createView(
            payload.name,
            payload.criteria,
            payload.criteriaText,
          );
          // Push to local state immediately — the sidebar reads from
          // `views` (client-side), so the new row appears before any
          // server re-fetch could complete.
          setViews((prev) => [...prev, created]);
          // Auto-enter the newly created view so the user sees the result.
          setCurrentViewIdRaw(created.id);
          setScopeRaw(emptyScope);
          setAdvanced(payload.criteria);
        } else if (viewDialog?.mode === "edit") {
          const updated = await updateView(
            viewDialog.view.id,
            payload.name,
            payload.criteria,
            payload.criteriaText,
          );
          setViews((prev) =>
            prev.map((v) => (v.id === updated.id ? updated : v)),
          );
          // If we just edited the active view, refresh its loaded criteria.
          if (currentViewId === viewDialog.view.id) {
            setAdvanced(payload.criteria);
          }
        }
        // CRUD on views → server-side cache is invalidated; bump the
        // hook trigger so the sidebar badges refresh on the next poll.
        setViewCountsTrigger(n => n + 1);
      } catch (err) {
        console.error("view save failed", err);
      }
    },
    [viewDialog, currentViewId],
  );

  const handleViewDelete = React.useCallback(
    async (viewId: string) => {
      try {
        await deleteView(viewId);
        setViews((prev) => prev.filter((v) => v.id !== viewId));
        if (currentViewId === viewId) {
          setCurrentViewIdRaw(null);
          setAdvanced(userPrefs);
        }
        setViewCountsTrigger(n => n + 1);
      } catch (err) {
        console.error("view delete failed", err);
      }
    },
    [currentViewId, userPrefs],
  );

  // Folder create / rename / delete live in /library/{id}. The Watch
  // only keeps the picker (Add-to-folder action on RowActions) — see
  // below.

  /* ── Folder picker state + add/remove/inline-create handlers ──
   * `folderPickerStoryId` holds the story currently being filed via the
   * picker dialog. Toggling membership runs an optimistic update on
   * `overrides.folder_ids` for that story AND on the target folder's
   * `story_count`, then fires the API. */
  const [folderPickerStoryId, setFolderPickerStoryId] = React.useState<
    number | null
  >(null);

  const handleOpenFolders = React.useCallback((storyId: number) => {
    setFolderPickerStoryId(storyId);
  }, []);

  /* ── Share / export handler ──
   * Lives only on the DetailPanel (= the cluster card RowActions don't
   * carry a share button anymore — one entry point, less toolbar
   * clutter). The hook handles the id lookup, clipboard write, and
   * toast feedback. */
  const handleShare = useStoryShare(data.stories, data.singletons);

  const currentFolderIdsFor = React.useCallback(
    (storyId: number): string[] => {
      // Effective folder_ids = optimistic override > base user_state.
      const override = overrides.get(storyId);
      if (override?.folder_ids !== undefined) return override.folder_ids;
      const story = data.stories.find(
        (s) => s.articles[0]?.story_id === storyId,
      );
      if (story?.user_state?.folder_ids) return story.user_state.folder_ids;
      const singleton = data.singletons.find((a) => a.story_id === storyId);
      return singleton?.user_state?.folder_ids ?? [];
    },
    [overrides, data.stories, data.singletons],
  );

  const handleAddToFolder = React.useCallback(
    async (folderId: string) => {
      const storyId = folderPickerStoryId;
      if (storyId === null) return;
      const prevFolderIds = currentFolderIdsFor(storyId);
      if (prevFolderIds.includes(folderId)) return;
      // Save and Folder are independent. Adding to a folder
      // updates folder_ids only; saved state stays whatever it was.
      applyOverride(storyId, {
        folder_ids: [...prevFolderIds, folderId],
      });
      setFolders((prev) =>
        prev.map((f) =>
          f.id === folderId ? { ...f, story_count: f.story_count + 1 } : f,
        ),
      );
      try {
        await addStoryToFolder(folderId, storyId);
      } catch (err) {
        console.error("add to folder failed", err);
        applyOverride(storyId, { folder_ids: prevFolderIds });
        setFolders((prev) =>
          prev.map((f) =>
            f.id === folderId
              ? { ...f, story_count: Math.max(0, f.story_count - 1) }
              : f,
          ),
        );
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, applyOverride],
  );

  const handleRemoveFromFolder = React.useCallback(
    async (folderId: string) => {
      const storyId = folderPickerStoryId;
      if (storyId === null) return;
      const prevFolderIds = currentFolderIdsFor(storyId);
      if (!prevFolderIds.includes(folderId)) return;
      applyOverride(storyId, {
        folder_ids: prevFolderIds.filter((id) => id !== folderId),
      });
      setFolders((prev) =>
        prev.map((f) =>
          f.id === folderId
            ? { ...f, story_count: Math.max(0, f.story_count - 1) }
            : f,
        ),
      );
      try {
        await removeStoryFromFolder(folderId, storyId);
      } catch (err) {
        console.error("remove from folder failed", err);
        applyOverride(storyId, { folder_ids: prevFolderIds });
        setFolders((prev) =>
          prev.map((f) =>
            f.id === folderId ? { ...f, story_count: f.story_count + 1 } : f,
          ),
        );
      }
    },
    [folderPickerStoryId, currentFolderIdsFor, applyOverride],
  );

  /** Inline create from the picker — server-side create only. The
   *  picker stages the new folder.id into its draft and the actual
   *  membership change ships at Save commit via `handleAddToFolder`. */
  const handlePickerCreate = React.useCallback(
    async (name: string) => {
      const created = await createFolder(name);
      setFolders((prev) => [...prev, created]);
      return created;
    },
    [],
  );

  return (
    <>
      <Sidebar
        aggs={aggsSidebar}
        scope={scope}
        onScopeChange={setScope}
        onReset={resetScopeAndView}
        view={view}
        onViewChange={setView}
        views={views}
        currentViewId={currentViewId}
        onSelectView={setCurrentView}
        onCreateView={handleCreateView}
        onEditView={handleEditView}
        counts={counts}
        unreadCounts={unreadCounts}
        isOwner={isOwner}
        viewCounts={viewCounts}
      />
      <ListPanel
        data={data}
        aggs={aggs}
        filteredStories={filtered.stories}
        filteredSingletons={filtered.singletons}
        scope={scope}
        advanced={advanced}
        onAdvancedChange={setAdvanced}
        userPrefs={userPrefs}
        currentView={
          currentViewId
            ? views.find((v) => v.id === currentViewId) ?? null
            : null
        }
        onEditView={
          currentViewId
            ? () => handleEditView(currentViewId)
            : undefined
        }
        // À la une: force communs at render so ListPanel preserves our
        // source-count DESC sort (the "all" tab interleaves clusters and
        // singletons by recency, which overrides any pre-sort).
        storyType={view === "top" ? "communs" : storyType}
        onStoryTypeChange={setStoryType}
        activeStoryId={activeStoryId}
        activeArticleId={activeArticleId}
        onToggle={toggleStory}
        onSave={handleSave}
        onUnsave={handleUnsave}
        onIgnored={handleIgnored}
        onUnignored={handleUnignored}
        onFollow={handleFollow}
        onUnfollow={handleUnfollow}
        onOpenFolders={handleOpenFolders}
        onMarkAllRead={isOwner ? handleMarkAllRead : undefined}
        unreadCount={counts.unread}
        viewIgnored={viewIgnored}
        locallyRead={locallyRead}
        overrides={overrides}
        consumedArticles={consumedArticles}
        onArticleConsume={handleArticleConsume}
        onArticlePreview={handleArticlePreview}
        onLoadMore={handleLoadMore}
        hasMore={accumulated.cursor !== null}
        isLoadingMore={isLoadingNext}
        scopeCounts={pageAggs.data?.by_scope}
        periodHours={periodHours}
        onPeriodHoursChange={setPeriodHours}
      />
      <DetailPanel
        stories={data.stories}
        singletons={data.singletons}
        activeStoryId={activeStoryId}
        activeArticleId={activeArticleId}
        onClose={closeStory}
        onBackToCluster={() => setActiveArticleId(null)}
        onShare={handleShare}
      />
      <ViewEditDialog
        open={viewDialog !== null}
        onOpenChange={(o) => {
          if (!o) setViewDialog(null);
        }}
        mode={viewDialog?.mode ?? "create"}
        initialView={
          viewDialog?.mode === "edit" ? viewDialog.view : undefined
        }
        aggs={aggs}
        universe={data.universe}
        onSubmit={handleViewSubmit}
        onDelete={handleViewDelete}
      />
      <FolderPickerDialog
        open={folderPickerStoryId !== null}
        onOpenChange={(o) => {
          if (!o) setFolderPickerStoryId(null);
        }}
        folders={folders}
        selectedFolderIds={
          folderPickerStoryId !== null
            ? currentFolderIdsFor(folderPickerStoryId)
            : []
        }
        onAdd={handleAddToFolder}
        onRemove={handleRemoveFromFolder}
        onCreate={handlePickerCreate}
      />
    </>
  );
}
