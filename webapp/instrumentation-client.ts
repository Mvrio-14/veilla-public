// Browser-side Sentry init. Next.js loads this automatically on the client.
// No-op unless NEXT_PUBLIC_SENTRY_DSN is set (the public var is required so
// the value is available in the browser bundle).
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
  // Errors only — no session replay / tracing by default to keep quota and
  // bundle weight down. Opt in later if needed.
  tracesSampleRate: 0,
  sendDefaultPii: false,
});

// Required by Next.js App Router for client-side navigation instrumentation.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
