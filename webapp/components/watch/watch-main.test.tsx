import { describe, expect, it, vi } from "vitest";

import { render, screen } from "@/test/render";
import { emptyWatchData, view } from "@/test/fixtures";
import { emptyAdvanced } from "@/lib/filter";
import { WatchMain } from "./watch-main";

/**
 * The two live indicators under Watch — the "new articles" pill and the
 * "checked at HH:MM" line — each fetch a catch-up value from the API on
 * mount. Rendered for real here, they reached for `api.test`, failed on
 * DNS a few milliseconds later, and logged the failure after Vitest had
 * started tearing the environment down: all tests green, run marked
 * failed, and only on some runs. They are not what this file checks, so
 * they are replaced by their resting state.
 */
vi.mock("@/lib/realtime/use-new-articles", () => ({
  useNewArticles: () => ({ count: 0, reset: () => {} }),
}));
vi.mock("@/lib/realtime/use-last-worker-check", () => ({
  useLastWorkerCheck: (initialTs: string | null) => initialTs,
}));

/**
 * WatchMain keeps client copies of several server-owned lists — saved
 * views, folders, read article ids, default filters — so that creating
 * a view or marking a story read shows up instantly instead of after a
 * refetch. Each copy is re-seeded from its prop by an effect.
 *
 * Those copies are the part of this component most likely to be
 * restructured, and the part where a mistake is invisible: the screen
 * simply keeps showing yesterday's list. The tests below describe what
 * the person sees, so the copies can be reimplemented — or removed —
 * without silently changing behaviour.
 */
describe("WatchMain", () => {
  it("mounts with an empty payload", () => {
    render(<WatchMain data={emptyWatchData()} />);
    expect(screen.getByText(/aucune story/i)).toBeInTheDocument();
  });

  it("lists the saved views it was given", () => {
    render(<WatchMain data={emptyWatchData({ views: [view("Énergie")] })} />);
    expect(screen.getByText("Énergie")).toBeInTheDocument();
  });

  it("says so plainly when there are no views yet", () => {
    render(<WatchMain data={emptyWatchData()} />);
    expect(screen.getByText(/aucune vue pour l'instant/i)).toBeInTheDocument();
  });

  it("picks up a view added by the server after mount", () => {
    // The refetch case: another tab created a view, /watch comes back
    // with one more. The sidebar has to follow the payload.
    const { rerender } = render(
      <WatchMain data={emptyWatchData({ views: [view("Énergie")] })} />,
    );
    expect(screen.queryByText("Défense")).not.toBeInTheDocument();

    rerender(
      <WatchMain
        data={emptyWatchData({ views: [view("Énergie"), view("Défense")] })}
      />,
    );

    expect(screen.getByText("Énergie")).toBeInTheDocument();
    expect(screen.getByText("Défense")).toBeInTheDocument();
  });

  it("drops a view the server no longer returns", () => {
    const { rerender } = render(
      <WatchMain
        data={emptyWatchData({ views: [view("Énergie"), view("Défense")] })}
      />,
    );
    expect(screen.getByText("Défense")).toBeInTheDocument();

    rerender(<WatchMain data={emptyWatchData({ views: [view("Énergie")] })} />);

    expect(screen.getByText("Énergie")).toBeInTheDocument();
    expect(screen.queryByText("Défense")).not.toBeInTheDocument();
  });

  it("applies the stored default filters on first paint", () => {
    // Preferences are the filter set someone saved in Settings. Landing
    // on Watch without them applied means the first thing they see is
    // not the feed they configured.
    render(
      <WatchMain
        data={emptyWatchData({
          preferences: { ...emptyAdvanced, langs: ["fr"], categories: ["Politics"] },
        })}
      />,
    );

    // The badge on the Filtres button counts active filter values.
    const filters = screen.getByRole("button", { name: /filtres/i });
    expect(filters).toHaveTextContent("2");
  });

  it("shows no filter badge when no preferences are stored", () => {
    render(<WatchMain data={emptyWatchData()} />);
    const filters = screen.getByRole("button", { name: /filtres/i });
    expect(filters).not.toHaveTextContent(/[0-9]/);
  });
});
