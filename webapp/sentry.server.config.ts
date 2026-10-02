// Sentry init for the Node.js server runtime. Loaded by instrumentation.ts.
// No-op unless SENTRY_DSN is set, so dev/preview without a DSN stay silent.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
  // Errors only by default — no performance tracing unless explicitly opted
  // in via env, so we don't burn Sentry quota by surprise.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
  sendDefaultPii: false,
});
