import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * Global test setup.
 *
 * `cleanup` unmounts anything a test rendered. Without it, components
 * from an earlier test stay in the document and queries like
 * `getByRole` start finding two matches and failing for a reason that
 * has nothing to do with the test that failed — the kind of flake that
 * costs an afternoon.
 */
afterEach(() => {
  cleanup();

  // Watch persists its UI state (filters, active view, story type) to
  // sessionStorage and restores it on mount. Without this, one test's
  // leftovers are restored over the next test's props and the failure
  // shows up somewhere unrelated — which is exactly what happened
  // while these tests were being written.
  sessionStorage.clear();
  localStorage.clear();
});

/**
 * Next's navigation hooks assert that an App Router is mounted, which
 * it never is outside `next dev`. Mocked here rather than per file
 * because any component deep enough to matter reaches one of them, and
 * a test failing on "app router not mounted" says nothing about the
 * behaviour it meant to check.
 *
 * The router is a set of spies: a test that cares whether navigation
 * happened asserts on them; every other test ignores them.
 */
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>(
    "next/navigation",
  );
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    }),
    usePathname: () => "/watch",
    useSearchParams: () => new URLSearchParams(),
  };
});
