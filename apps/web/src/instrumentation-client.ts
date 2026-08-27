// Sentry browser-runtime init — Next.js's own convention for this file
// (instrumentation-client.ts, sibling to instrumentation.ts) replaces the
// older sentry.client.config.ts pattern. Same dsn/no-op reasoning as
// ../../sentry.server.config.ts's own comment.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
  // Session Replay is off (0 sample rates) rather than omitted — explicit
  // "we considered this and said no for now" beats a silent gap, same
  // reasoning this codebase already gives elsewhere for a deliberately
  // narrow v1 scope. Replay records DOM/session content, which is a real
  // privacy decision (this app renders real client PII) this project
  // hasn't made yet, not something to turn on by default.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
