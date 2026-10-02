import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emptyAdvanced } from "@/lib/filter";
import { defaultWatchInputs } from "@/lib/watch-query";
import type { WatchAggregations } from "@/lib/actions";

vi.mock("./actions", () => ({
  fetchWatchAggs: vi.fn(),
  fetchWatchFiltered: vi.fn(),
  fetchViewCounts: vi.fn(),
}));

import { fetchWatchAggs } from "./actions";
import { useWatchAggs } from "./use-watch";
import { watchQueryHash } from "./watch-query";

const mockedFetch = vi.mocked(fetchWatchAggs);

function aggs(marker: string): WatchAggregations {
  // Only the marker matters here: these tests are about *when* a fetch
  // happens and *which* payload is visible, never about the shape.
  return { __marker: marker } as unknown as WatchAggregations;
}

/** Advance the debounce clock, then let the fetch promise settle.
 *
 *  Testing Library's `waitFor` polls on real timers, which never tick
 *  while `vi.useFakeTimers` is installed — mixing the two clocks hangs
 *  the test rather than failing it. Draining microtasks by hand inside
 *  `act` keeps one clock in play. */
async function flush(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

const inputs = defaultWatchInputs(emptyAdvanced);

beforeEach(() => {
  vi.useFakeTimers();
  mockedFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * These tests pin the three behaviours that make the Watch feel instant:
 * the server's first page is trusted instead of re-fetched, a disabled
 * hook never claims to be loading, and a filter change keeps the old
 * results on screen until the new ones land.
 *
 * All three live in an effect today. They are pinned here so that
 * moving them out cannot change them unnoticed.
 */
describe("useWatchAggs", () => {
  it("does not fetch, and does not claim to be loading, when disabled", () => {
    const { result } = renderHook(() =>
      useWatchAggs("someone", inputs, { enabled: false }),
    );

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("does not fetch without a slug", () => {
    const { result } = renderHook(() => useWatchAggs(null, inputs, {}));

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("serves the server payload on first paint without re-fetching", () => {
    // The whole point of the SSR embed: counters are right immediately,
    // not after a round-trip.
    const { result } = renderHook(() =>
      useWatchAggs("someone", inputs, {
        initialData: aggs("from-server"),
        initialHash: watchQueryHash(inputs),
      }),
    );

    expect(result.current.data).toEqual(aggs("from-server"));
    expect(result.current.isLoading).toBe(false);

    act(() => void vi.advanceTimersByTime(1000));
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("ignores a server payload that was computed for other filters", () => {
    const { result } = renderHook(() =>
      useWatchAggs("someone", inputs, {
        initialData: aggs("stale"),
        initialHash: "hash-of-something-else",
      }),
    );

    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);
  });

  it("keeps the previous results on screen until the new ones land", async () => {
    mockedFetch.mockResolvedValue(aggs("second"));

    const { result, rerender } = renderHook(
      ({ i }) =>
        useWatchAggs("someone", i, {
          initialData: aggs("first"),
          initialHash: watchQueryHash(inputs),
        }),
      { initialProps: { i: inputs } },
    );

    expect(result.current.data).toEqual(aggs("first"));

    // A filter moves: same hook, different inputs.
    rerender({ i: { ...inputs, periodHours: 72 } });

    // Inside the debounce window nothing is announced yet. `isLoading`
    // only turns on once the request actually departs, so holding a key
    // down does not strobe a spinner on and off.
    expect(result.current.data).toEqual(aggs("first"));
    expect(result.current.isLoading).toBe(false);

    await flush(300);

    // And once it has landed, the new numbers replace the old ones —
    // the old ones having stayed on screen throughout.
    expect(result.current.data).toEqual(aggs("second"));
    expect(result.current.isLoading).toBe(false);
  });

  it("waits out the debounce instead of firing on every keystroke", async () => {
    mockedFetch.mockResolvedValue(aggs("x"));

    const { rerender } = renderHook(
      ({ i }) => useWatchAggs("someone", i, {}),
      { initialProps: { i: inputs } },
    );

    mockedFetch.mockClear();

    for (const q of ["m", "ma", "mac", "macr"]) {
      rerender({ i: { ...inputs, advanced: { ...emptyAdvanced, query: q } } });
      await flush(50);
    }

    expect(mockedFetch).not.toHaveBeenCalled();

    await flush(300);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
