import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/api", () => ({
  listSources: vi.fn(),
  listFeeds: vi.fn(),
  createFeed: vi.fn(),
  probeFeed: vi.fn(),
  setFeedStatus: vi.fn(),
  updateFeed: vi.fn(),
}));

import { listFeeds, listSources } from "@/lib/admin/api";
import { render, screen } from "@/test/render";
import { adminFeed, adminSource } from "@/test/fixtures";
import { SourcesFeedsClient } from "./sources-feeds-client";

beforeEach(() => {
  vi.mocked(listSources).mockReset();
  vi.mocked(listFeeds).mockReset();
});

/** Smoke coverage written before this screen's data loading was
 *  restructured. See the note in users-client.test.tsx. */
describe("SourcesFeedsClient", () => {
  it("announces that it is loading before anything arrives", () => {
    vi.mocked(listSources).mockResolvedValue([adminSource()]);
    vi.mocked(listFeeds).mockResolvedValue([adminFeed()]);
    render(<SourcesFeedsClient />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("lists the sources it fetched, with their feed tally", async () => {
    vi.mocked(listSources).mockResolvedValue([adminSource()]);
    vi.mocked(listFeeds).mockResolvedValue([adminFeed()]);

    render(<SourcesFeedsClient />);

    // The domain line is the source row; the name alone also appears in
    // the feed table on the right.
    expect(await screen.findByText(/lemonde\.fr.*2 alive/)).toBeInTheDocument();
  });

  it("excludes dead feeds unless asked", async () => {
    vi.mocked(listSources).mockResolvedValue([adminSource()]);
    vi.mocked(listFeeds).mockResolvedValue([adminFeed()]);

    render(<SourcesFeedsClient />);
    await screen.findByText(/lemonde\.fr.*2 alive/);

    expect(listSources).toHaveBeenCalledWith({ include_dead: false });
    expect(listFeeds).toHaveBeenCalledWith({ include_dead: false });
  });

  it("surfaces a failed load instead of staying blank", async () => {
    vi.mocked(listSources).mockRejectedValue(new Error("Boom from the API"));
    vi.mocked(listFeeds).mockResolvedValue([]);

    render(<SourcesFeedsClient />);

    expect(await screen.findByText(/Boom from the API/)).toBeInTheDocument();
  });
});
