// Next.js instrumentation hook — the one place both server and edge
// Sentry configs actually get loaded, per Next.js's own instrumentation
// API (register() runs once, before any other server code). See
// ../sentry.server.config.ts's own comment for why this is a manual
// setup rather than the wizard's output.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Captures errors from React Server Components (Next.js 15's own
// instrumentation hook for this — not something sentry.server.config.ts's
// plain Sentry.init() covers by itself).
export const onRequestError = Sentry.captureRequestError;
