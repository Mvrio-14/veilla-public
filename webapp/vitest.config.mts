import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Vitest configuration for the webapp.
 *
 * ## Why jsdom and not the browser
 *
 * Everything under test here is state logic — what a hook returns when a
 * prop changes, whether a dialog starts empty, which stories a filter
 * keeps. None of it depends on layout or real painting, so a DOM
 * implementation in Node is both sufficient and about two orders of
 * magnitude faster than a browser. The day a test needs real layout, it
 * belongs in an end-to-end runner, not here.
 *
 * ## Why no @vitejs/plugin-react
 *
 * Vitest's own transformer already compiles JSX with the automatic
 * runtime, reading `jsx` from tsconfig.json. The plugin adds Fast
 * Refresh and a Babel pipeline, neither of which a test run uses — and
 * it currently conflicts with this project's dependency tree. One less
 * moving part.
 *
 * The file is `.mts` rather than `.ts` because the package is CommonJS;
 * without the extension Node loads this ESM config as CJS and warns on
 * every run.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path in tsconfig.json. The two have to agree or
      // tests resolve imports differently from the app they test.
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    // The Supabase browser client throws at construction without these,
    // and components create one on mount. Obvious fakes rather than real
    // values: nothing here should reach the network, and a test that
    // starts doing so should fail loudly on a bad host, not quietly
    // succeed against a real project.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
      NEXT_PUBLIC_API_URL: "http://api.test",
    },
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**", ".next/**"],
    restoreMocks: true,
  },
});
