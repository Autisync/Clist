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
to point at something real and reachable. Two things have to be true before
that variable can point at anything meaningful:

1. **`apps/api` needs to actually run somewhere with a public URL.**
   Vercel's own serverless functions are not a good fit for it as-is —
   Fastify is written as a long-running server, and two of its
   responsibilities specifically don't fit a stateless serverless model:
   Playwright (REF PDF generation, `apps/api/src/routes/ref.ts`) needs a
   real headless-Chromium process, and the whole app currently assumes one
   long-lived process. A Node-friendly host that runs a persistent process
   (Railway, Render, Fly.io, etc.) is the natural fit for `apps/api` as it
   exists today.
2. **`apps/api`'s database needs to stop being PGlite.** PGlite
   (`apps/api/src/db.ts`) is an embedded, in-process, on-disk WASM Postgres
   — explicitly documented everywhere in this repo as a Phase 1 stand-in,
   never a production database. It cannot be shared across multiple
   instances or survive a redeploy the way a real Postgres server does.
   `db.ts`'s own comment already anticipated this exact swap ("real Fly
   Postgres/Neon instead of PGlite, same connection setup") — that's a
   separate, smaller change from the full Supabase-native RLS migration
   this repo has also been doing, and it hasn't been done yet either. The
   real Supabase Postgres project already proven throughout `§6` could
   serve this role directly (`apps/api` connecting to it as a trusted
   backend client, no RLS/anon-key involved for that connection — a
   completely different use of the same database than the Supabase-native
   RPCs use), which would mean one Postgres project for both halves of the
   architecture during the transition, rather than a third database to
   provision and keep in sync.

Until both of those are true, `apps/web` can deploy to Vercel and its
*already-cut-over* pages will work correctly against real, hosted Supabase
infrastructure — but the pages still depending on Fastify will fail exactly
the way they do in local dev today when `apps/api` isn't running (a clear
500, not a silent wrong answer — see `README.md`'s "still entirely
Fastify-backed" list). That's an honest, incremental deployment state, not
a broken one: it's the same shape the local dev environment is already in
right now.
