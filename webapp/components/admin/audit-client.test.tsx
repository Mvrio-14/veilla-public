import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/api", () => ({
  listAudit: vi.fn(),
  listUsers: vi.fn(),
}));

import { listAudit, listUsers } from "@/lib/admin/api";
import { render, screen } from "@/test/render";
import { adminAuditRow, adminUser } from "@/test/fixtures";
import { AuditClient } from "./audit-client";

beforeEach(() => {
  vi.mocked(listAudit).mockReset();
  vi.mocked(listUsers).mockReset();
  vi.mocked(listUsers).mockResolvedValue([adminUser()]);
});

/** Smoke coverage written before this screen's data loading was
 *  restructured. See the note in users-client.test.tsx. */
describe("AuditClient", () => {
  it("announces that it is loading before anything arrives", () => {
    vi.mocked(listAudit).mockResolvedValue({ actions: [], has_more: false, next_before_id: null });
    render(<AuditClient />);
    // The word appears in the header tally and in the table body.
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0);
  });

  it("lists the audit rows it fetched", async () => {
    vi.mocked(listAudit).mockResolvedValue({
      actions: [adminAuditRow({ action: "feed.kill" })],
      has_more: false,
      next_before_id: null,
    });

    render(<AuditClient />);

    // The verb also appears as an option in the Action filter, so the
    // assertion counts rows instead of matching the verb.
    expect(await screen.findByText(/1 rows loaded/i)).toBeInTheDocument();
    expect(screen.getAllByText("feed.kill").length).toBeGreaterThan(1);
  });

  it("asks for the first page with no filters on arrival", async () => {
    vi.mocked(listAudit).mockResolvedValue({ actions: [], has_more: false, next_before_id: null });

    render(<AuditClient />);
    await screen.findByText(/0 rows loaded/i);

    expect(listAudit).toHaveBeenCalledWith({
      actor_user_id: undefined,
      action: undefined,
      target_type: undefined,
      target_id: undefined,
      limit: 100,
    });
  });

  it("surfaces a failed load instead of staying blank", async () => {
    vi.mocked(listAudit).mockRejectedValue(new Error("Boom from the API"));

    render(<AuditClient />);

    expect(await screen.findByText(/Boom from the API/)).toBeInTheDocument();
  });
});
