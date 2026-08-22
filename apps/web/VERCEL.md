# Deploying `apps/web` to Vercel

This app is ready to deploy to Vercel today — the build succeeds
(`npm run build`) and every page that's been cut over to Supabase (see
`README.md`'s §6 Step 5 section) needs nothing but the Supabase project
itself, which is already real, hosted infrastructure. What's **not**
resolved yet is documented honestly below, not glossed over.

## Vercel project settings

- **Root Directory:** `apps/web` (this is an npm-workspaces monorepo —
  Vercel's own monorepo support handles installing from the repo root and
  building within this directory; no `vercel.json` is required for that).
- **Framework preset:** Next.js (auto-detected).
- **Build/install commands:** leave at Vercel's Next.js defaults. `packages/core`
  needs no separate build step — it's consumed straight from its TypeScript
  source (see `README.md`'s note on this and `next.config.ts`'s
  `extensionAlias` fix), so a normal `npm install` at the workspace root is
  sufficient.

## Required environment variables

Set these in the Vercel project's Environment Variables settings (not
committed anywhere — see `.env.example` for names only, matching this
repo's existing credential-hygiene convention):

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Safe to expose to the browser — this is what "anon" + RLS means. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the project's `anon` key | Same — safe to ship client-side, RLS is the actual boundary. |
| `FIELDREADY_API_ORIGIN` | the real, publicly-reachable URL of a deployed `apps/api` | See "The one remaining gap" below — `127.0.0.1:3001` (the local-dev default) obviously cannot resolve from Vercel's servers. |

## The one remaining gap: `apps/api` needs its own real host

Every page not yet cut over to Supabase — job detail (dispatch, checklist,
execution steps, test results, close-out), clients, quotes, suppliers,
technicians, the dashboard, and all of `/field/*` — still calls Fastify via
the `/api/*` rewrite (`next.config.ts`), which needs `FIELDREADY_API_ORIGIN`
to point at something real and reachable.

**Resolved:** `apps/api`'s database is no longer PGlite. It now connects to
the same real Supabase Postgres project already proven throughout `§6`, as
a plain trusted-backend client (`postgres` role, no RLS/anon-key involved
— a completely different use of the same project than the Supabase-native
RPCs use), scoped to its own dedicated schema (`fastify_api`) so it can
never collide with the real, RLS-governed data in `public`. See
`apps/api/README.md`'s "Fastify→real-Postgres swap" section for the full
rundown. One Postgres project now serves both halves of the architecture
during the transition — no separate database to provision.

**Still open:** `apps/api` needs to actually run somewhere with a public
URL. Vercel's own serverless functions are not a good fit for it as-is —
Fastify is written as a long-running server, and Playwright (REF PDF
generation, `apps/api/src/routes/ref.ts`) needs a real headless-Chromium
process, which doesn't fit a stateless serverless model. A Node-friendly
host that runs a persistent process (Railway, Render, Fly.io, etc.) is the
natural fit for `apps/api` as it exists today — set that host's environment
variables from `apps/api/.env.example` (the same `SUPABASE_PROJECT_REF`/
`SUPABASE_DB_PASSWORD`/`SUPABASE_SERVICE_ROLE_KEY` already in use, plus
`VERYFI_*` if a real OCR vendor is ever wired in), then point `apps/web`'s
`FIELDREADY_API_ORIGIN` at its public URL.

Until that host exists, `apps/web` can deploy to Vercel and its
*already-cut-over* pages will work correctly against real, hosted Supabase
infrastructure — but the pages still depending on Fastify will fail exactly
the way they do in local dev today when `apps/api` isn't running (a clear
500, not a silent wrong answer — see `README.md`'s "still entirely
Fastify-backed" list). That's an honest, incremental deployment state, not
a broken one: it's the same shape the local dev environment is already in
right now.
