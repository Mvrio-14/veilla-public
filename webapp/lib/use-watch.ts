"use client";

/**
 * Hooks that drive server-side /watch queries.
 *
 * Two hooks, two responsibilities:
 *
 *   - `useWatchAggs(slug, inputs)`  → sidebar aggregations. Debounced
 *     250ms, cancellable, swr-style (keeps last result visible while
 *     refetching). Returns `{ data, isLoading, error }`.
 *
 *   - `useWatchPage(slug, inputs, cursor, itemType)` → the paginated
 *     story list. Refetches whenever `inputs` change OR `cursor` is
 *     reset to null. Cancellable. Returns `{ data, isLoading, error }`.
 *
 * # Why hooks (vs. SWR / TanStack Query / Realtime)
 *
 * We deliberately avoid pulling in TanStack Query. These hooks cover the
 * narrow needs of /watch (one cancellable fetch + last-result-stays-visible)
 * with about 80 lines and zero extra deps. If the SPA grows more
 * complex caches (mutations + invalidation across pages), TanStack
 * becomes worth the dep weight.
 *
 * # AbortController + debounce
 *
 * When the user types into the search box, every keystroke would
 * fire a request without debouncing — that's a /watch + /aggregations
 * pair per character. The debounce delays the actual fetch by 250ms
 * after the last input change. AbortController on top of that cancels
 * any still-in-flight request when a NEW fetch starts (= user typed
 * past the debounce window). Net: only the last keystroke's response
 * ever lands.
 *
 * # Why stale-while-revalidate matters here
 *
 * Refetching on every filter change would mean a flash of empty state
 * each time. Instead we keep `data` from the previous query visible
 * until the new response arrives, surfacing the transition only via
 * `isLoading`. The SPA can dim the list / show a spinner on top —
 * standard Linear / Notion pattern.
 */
import * as React from "react";
import {
  fetchViewCounts,
  fetchWatchAggs,
  fetchWatchFiltered,
  type WatchAggregations,
} from "./actions";
import type { WatchData } from "./types";
import { watchQueryHash, type WatchQueryInputs } from "./watch-query";
import { useChanged } from "./use-changed";


// Default debounce — long enough to skip typing-in-search-bar keystrokes,
// short enough that the user perceives the response as responsive when
// they stop. 250ms matches Algolia / Linear conventions.
const DEBOUNCE_MS = 250;


/** Generic state shape for both hooks. */
export interface WatchQueryHookState<T> {
  /** Last successfully fetched payload, or null on the first render. */
  data:      T | null;
  /** True while a request is in flight (initial OR re-fetch). */
  isLoading: boolean;
  /** Last error (Response or Error), cleared on the next successful fetch. */
  error:     unknown | null;
}


/**
 * Aggregations hook. Re-fetches whenever `inputs` changes, debounced
 * by `debounceMs` (default 250ms). Cancels in-flight on each change.
 *
 * Set `enabled=false` to skip fetching entirely (= anon viewers or
 * during the initial SSR render when we don't have a queryState yet).
 */
export function useWatchAggs(
  slug:    string | null,
  inputs:  WatchQueryInputs,
  opts: {
    enabled?:     boolean;
    debounceMs?:  number;
    /** Pre-fetched aggregations payload from the server's /watch initial
     *  response embed. When set AND `initialHash` matches
     *  the current inputs' hash, the hook skips the first fetch and
     *  serves this payload straight to consumers — counters are correct
     *  from the very first paint instead of after a 1-13s refetch. */
    initialData?: WatchAggregations | null;
    /** Hash of the inputs the `initialData` corresponds to. Computed by
     *  the caller via `watchQueryHash()` on the QueryState that the
     *  server-side `/watch` call used. When this matches the live
     *  `hash` of `inputs`, the hook treats `initialData` as valid and
     *  emits it on the first render. */
    initialHash?: string;
  } = {},
): WatchQueryHookState<WatchAggregations> {
  const enabled     = opts.enabled    ?? true;
  const debounceMs  = opts.debounceMs ?? DEBOUNCE_MS;
  const initialData = opts.initialData ?? null;
  const initialHash = opts.initialHash;

  // Stable dep key — JSON.stringify of the serialized params, so React
  // sees identical-content inputs as the same dep regardless of
  // referential identity. See `watchQueryHash`.
  const hash = watchQueryHash(inputs);

  // Initial state: if the SSR payload matches the current hash, seed
  // with it. Otherwise stay empty (= isLoading until first fetch).
  const initialIsValid = !!initialData && initialHash === hash;
  const [state, setState] = React.useState<WatchQueryHookState<WatchAggregations>>({
    data:      initialIsValid ? initialData : null,
    isLoading: enabled && !initialIsValid,
    error:     null,
  });

  // Track whether the very-first effect run has happened, so we can
  // skip refetching on mount when the initial data was honored.
  const isFirstRunRef = React.useRef(true);

  const disabled = !enabled || !slug;

  React.useEffect(() => {
    if (disabled) return;

    // Skip the first fetch when the SSR embed already serves the
    // current hash. Any subsequent hash change (= user moved a filter)
    // refetches normally.
    const skipFirst = isFirstRunRef.current && initialHash === hash;
    isFirstRunRef.current = false;
    if (skipFirst) return;

    const controller  = new AbortController();
    const debounceTid = setTimeout(() => {
      setState(s => ({ ...s, isLoading: true, error: null }));
      fetchWatchAggs(slug, inputs, controller.signal)
        .then(data => {
          if (controller.signal.aborted) return;
          setState({ data, isLoading: false, error: null });
        })
        .catch(err => {
          if (controller.signal.aborted) return;
          // AbortError surfaces here in some browsers — treat as cancel.
          if ((err as { name?: string })?.name === "AbortError") return;
          setState(s => ({ ...s, isLoading: false, error: err }));
        });
    }, debounceMs);

    return () => {
      clearTimeout(debounceTid);
      controller.abort();
    };
    // `hash` is the content-identity of `inputs`; reading the freshest
    // `inputs` inside the effect via closure is fine because the effect
    // re-runs whenever the hash changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, slug, enabled, debounceMs, initialHash, disabled]);

  // A disabled hook is not loading — that is a fact about the arguments,
  // readable from them, not a state the effect has to go and correct.
  return React.useMemo(
    () => (disabled ? { ...state, isLoading: false } : state),
    [disabled, state],
  );
}


/**
 * Paginated /watch hook. Fetches the first page (cursor=null) on every
 * `inputs` change; subsequent pages are loaded via `loadMore()`.
 *
 * Unlike `useWatchAggs`, this hook owns the accumulated pages state:
 * the SPA renders `data.stories` / `data.singletons` as the visible
 * list, and `loadMore()` extends that list with the next page. A
 * filter change resets the cursor and replaces the accumulated state
 * with the fresh result.
 *
 * Caller responsibilities:
 *   - Pass `inputs` that reflect every filter the user can change.
 *   - Pass `initialData` if the SPA already has a server-rendered first
 *     page (typical: it does, from the `/watch` page server component).
 *     The hook treats it as the data for the unmodified input hash; the
 *     first re-fetch happens only when the user changes a filter.
 */
export interface UseWatchPageState extends WatchQueryHookState<WatchData> {
  /** Trigger fetching the next page. No-op when no cursor remains. */
  loadMore:       () => void;
  /** True while the next-page fetch is in flight. Distinct from
   *  `isLoading` which covers the inputs-changed refetch. */
  isLoadingMore:  boolean;
  /** True iff the latest payload's `next_cursor` is non-null. */
  hasMore:        boolean;
}


export function useWatchPage(
  slug:        string | null,
  inputs:      WatchQueryInputs,
  opts: {
    enabled?:     boolean;
    debounceMs?:  number;
    initialData?: WatchData | null;
    /** When set, the hook treats this hash as already-served by
     *  `initialData` and skips the first re-fetch. Subsequent input
     *  changes (different hash) refetch normally. */
    initialHash?: string;
    itemType?:    "all" | "communs" | "originaux";
    limit?:       number;
  } = {},
): UseWatchPageState {
  const enabled     = opts.enabled     ?? true;
  const debounceMs  = opts.debounceMs  ?? DEBOUNCE_MS;
  const itemType    = opts.itemType    ?? "all";
  const limit       = opts.limit;
  const initialData = opts.initialData ?? null;
  const initialHash = opts.initialHash;

  const hash = watchQueryHash(inputs);

  // Accumulator: stories+singletons across pages of the SAME hash.
  // When the hash changes, the effect below replaces this with the
  // fresh first page (cursor reset).
  const [data, setData]                 = React.useState<WatchData | null>(initialData);
  const [isLoading, setIsLoading]       = React.useState<boolean>(false);
  const [isLoadingMore, setLoadingMore] = React.useState<boolean>(false);
  const [error, setError]               = React.useState<unknown | null>(null);

  // Ref so `loadMore` reads the freshest cursor without re-binding.
  //
  // Written after commit, not during render: React may render a
  // component and throw the work away, and a ref mutated on the way
  // through would keep the discarded value. One commit of lag is
  // harmless here — `loadMore` only ever runs from a scroll or a
  // click, both of which happen after the commit that set it.
  const cursorRef = React.useRef<string | null>(data?.next_cursor ?? null);
  React.useEffect(() => {
    cursorRef.current = data?.next_cursor ?? null;
  }, [data?.next_cursor]);

  // Refetch on hash change. Skip the very first effect run when
  // `initialHash === hash` — the SSR already served it.
  const isFirstRunRef = React.useRef(true);

  const disabled = !enabled || !slug;

  React.useEffect(() => {
    if (disabled) return;

    const skipFirst = isFirstRunRef.current && initialHash === hash;
    isFirstRunRef.current = false;
    if (skipFirst) return;

    const controller  = new AbortController();
    const debounceTid = setTimeout(() => {
      setIsLoading(true);
      setError(null);
      fetchWatchFiltered(slug, inputs, {
        cursor:   null,           // fresh first page on filter change
        limit,
        itemType,
        signal:   controller.signal,
      })
        .then(fresh => {
          if (controller.signal.aborted) return;
          setData(fresh);
          setIsLoading(false);
        })
        .catch(err => {
          if (controller.signal.aborted) return;
          if ((err as { name?: string })?.name === "AbortError") return;
          setError(err);
          setIsLoading(false);
        });
    }, debounceMs);

    return () => {
      clearTimeout(debounceTid);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, slug, enabled, debounceMs, itemType, limit, initialHash]);

  // Next-page loader. Captures the current inputs via closure so the
  // request reflects the filter state at the moment of the call (= the
  // virtualizer's "near bottom" trigger).
  const loadMore = React.useCallback(() => {
    if (!enabled || !slug) return;
    if (isLoadingMore || isLoading) return;
    const cursor = cursorRef.current;
    if (!cursor) return;

    const controller = new AbortController();
    setLoadingMore(true);
    setError(null);
    fetchWatchFiltered(slug, inputs, {
      cursor,
      limit,
      itemType,
      signal: controller.signal,
    })
      .then(next => {
        if (controller.signal.aborted) return;
        setData(prev => {
          if (!prev) return next;
          return {
            ...prev,
            stories:    [...prev.stories,    ...next.stories],
            singletons: [...prev.singletons, ...next.singletons],
            next_cursor: next.next_cursor,
            // The next-page payload omits the SSR-only initial state
            // (views/folders/universe/preferences/aggs_server) — keep
            // the ones already in `prev`.
          };
        });
        setLoadingMore(false);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(err);
        setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, slug, isLoading, isLoadingMore, hash, itemType, limit]);

  return {
    data,
    // Same reasoning as in useWatchAggs: disabled is not loading, and
    // that is readable from the arguments.
    isLoading: disabled ? false : isLoading,
    isLoadingMore,
    hasMore: !!data?.next_cursor,
    error,
    loadMore,
  };
}


/**
 * Per-view item counts hook.
 *
 * Fires `GET /me/views/counts` once on mount and returns `{viewId: int}`
 * for the user's saved views. The sidebar's "Mes vues" section reads
 * the result to render a count badge next to each view name.
 *
 * # Why a separate hook vs. embedding in /watch
 *
 * The server-side compute can take 10-30s on big users (cold cache).
 * Inlining into /watch would block the initial page paint for that
 * long. Firing this hook AFTER /watch returns keeps the page snappy;
 * counts paint when ready. The API caches results for 60s so repeat
 * loads / view-CRUD round-trips return instantly.
 *
 * Re-fires on `triggerKey` changes — the caller bumps this to force a
 * refresh (= after view CRUD, after navigation away & back, etc.).
 */
export function useViewCounts(
  enabled: boolean,
  triggerKey: string | number = 0,
  periodHours?: number,
): WatchQueryHookState<Record<string, number>> {
  const [state, setState] = React.useState<WatchQueryHookState<Record<string, number>>>({
    data:      null,
    isLoading: enabled,
    error:     null,
  });

  // Entering the loading state is a consequence of the request key
  // changing, so it is decided here. The initial value already covers
  // the first request; this covers every later one.
  const requestKey = `${enabled}|${triggerKey}|${periodHours}`;
  if (useChanged(requestKey) && enabled) {
    setState(s => ({ ...s, isLoading: true, error: null }));
  }

  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchViewCounts(periodHours, controller.signal)
      .then(payload => {
        if (controller.signal.aborted) return;
        setState({ data: payload.counts ?? {}, isLoading: false, error: null });
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        if ((err as { name?: string })?.name === "AbortError") return;
        setState(s => ({ ...s, isLoading: false, error: err }));
      });
    return () => controller.abort();
  }, [enabled, triggerKey, periodHours]);

  return React.useMemo(
    () => (enabled ? state : { ...state, isLoading: false }),
    [enabled, state],
  );
}
