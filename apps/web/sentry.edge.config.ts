// Sentry edge-runtime init (middleware.ts runs here) — same reasoning as
// sentry.server.config.ts's own comment on why this is a manual setup and
// why dsn reads the NEXT_PUBLIC_ var.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
});
