import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin/api", () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
}));

import { listUsers } from "@/lib/admin/api";
import { render, screen } from "@/test/render";
import { adminUser } from "@/test/fixtures";
import { UsersClient } from "./users-client";

beforeEach(() => {
  vi.mocked(listUsers).mockReset();
});

/**
 * Smoke coverage for the admin screens, written before their data
 * loading was restructured.
 *
 * These screens are not a surface anyone watches, so a regression would
 * surface weeks later as "the admin page is broken". The tests pin what
 * must keep working: the screen says it is loading, shows what came
 * back, and says so when nothing did.
 */
describe("UsersClient", () => {
  it("announces that it is loading before anything arrives", () => {
    vi.mocked(listUsers).mockResolvedValue([adminUser()]);
    render(<UsersClient />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("lists the users it fetched", async () => {
    vi.mocked(listUsers).mockResolvedValue([adminUser()]);

    render(<UsersClient />);

    expect(await screen.findByText("Camille Roy")).toBeInTheDocument();
  });

  it("marks the accounts on the pro plan", async () => {
    vi.mocked(listUsers).mockResolvedValue([
      adminUser(),
      adminUser({ id: "user-2", name: "Léa Martin", slug: "lea", plan: "pro" }),
    ]);

    render(<UsersClient />);
    await screen.findByText("Léa Martin");

    expect(screen.getAllByText("pro")).toHaveLength(1);
  });

  it("surfaces a failed load instead of staying blank", async () => {
    vi.mocked(listUsers).mockRejectedValue(new Error("Boom from the API"));

    render(<UsersClient />);

    expect(await screen.findByText(/Boom from the API/)).toBeInTheDocument();
  });
});
