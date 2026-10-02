import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withSentryConfig } from "@sentry/nextjs";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  /* config options here */
};

// Sentry wraps the (already next-intl-wrapped) config. Source-map upload is
// driven by SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN env vars at build
// time — when they're absent (local, preview without secrets) the build still
// succeeds, it just skips the upload. Runtime error capture is independent of
// this and only needs the DSN env vars.
export default withSentryConfig(withNextIntl(nextConfig), {
  silent: !process.env.CI,
  widenClientFileUpload: true,
});
