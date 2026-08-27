// Sentry server-runtime init — production-readiness item, error monitoring.
// Manual setup, not the wizard: `npx @sentry/wizard` needs a real TTY for
// its interactive confirm/select prompts (@clack/prompts), which this
// environment's shell doesn't provide — confirmed by a real crash
// (ERR_TTY_INIT_FAILED), not assumed. This file, sentry.edge.config.ts,
// src/instrumentation.ts, src/instrumentation-client.ts, and
// src/app/global-error.tsx together are exactly what the wizard would
// have generated for a Next.js App Router + src/ project.
//
// dsn reads NEXT_PUBLIC_SENTRY_DSN, not a server-only var — a DSN is
// meant to be public (it identifies where to send events, it isn't a
// write-protected secret; Sentry's own docs say so), and the SDK's own
// documented behavior is to silently no-op with no dsn configured, same
// "swap in when a real credential shows up" pattern this project already
// uses for GOOGLE_PLACES_API_KEY/NEXT_PUBLIC_GA_MEASUREMENT_ID — no
// separate on/off gate needed here.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 1.0,
});
