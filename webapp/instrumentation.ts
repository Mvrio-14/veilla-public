// Server instrumentation entry. Next.js calls register() once per server
// instance; we load the runtime-appropriate Sentry config. onRequestError
// forwards uncaught server errors (RSC render, route handlers, actions) to
// Sentry. All no-op unless SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
