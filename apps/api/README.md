# @fieldready/api

Phase 1 implementation (CLAUDE.md build order): tenancy + RLS wired through a
real API, both auth flows, the template engine, and the offline sync proof.
No job domain logic beyond what's needed to have something to sync
(architecture §8) — quotes, dispatch, receipts, compliance forms, etc. are
Phase 2+.

## Stack notes — what matches the docs and what's substituted, and why

| Doc says | This uses | Why |
|---|---|---|
| pnpm workspaces | npm workspaces | No root access in the sandbox this was built in to install pnpm globally; npm ships with Node and workspaces work the same way. Swap freely — nothing depends on pnpm specifically. |
| Turborepo | (not added) | Two packages, one dev command — no build-orchestration problem yet for it to solve. Add it when there's a third app or a real build pipeline. |
| Postgres 16+, Drizzle | PGlite, raw SQL | No Docker/root available to run a real Postgres server in this environment. PGlite **is** real Postgres (compiled to WASM) — same SQL, same RLS, same triggers, already the verification method `verify-schema.mjs`/`verify-seed.mjs` use. Swapping to a real server for deployment (Fly Postgres/Neon, per architecture §2) is a change to `src/db.ts`'s connection setup only. Drizzle is deferred for the same reason the verification harnesses use raw SQL: fewer places a schema/ORM mismatch can hide while the foundational risk is what's being proven. |
| Fastify | Fastify | As specified. |

## Running it

```bash
npm install                 # from the repo root — installs and links both workspaces
npm run dev:api              # starts the API on http://127.0.0.1:3001
```

First boot applies `03-schema.sql` + `seed.sql` + a small set of Phase 1
fixtures (two tenants, an office login each, one technician device, one job
with one checklist item) to an embedded PGlite database. Where that database
lives is deliberately **outside** this repo folder — `$TMPDIR/fieldready-dev`
by default, override with `FIELDREADY_RUNTIME_DIR`. See `src/runtime-dir.ts`
for why (short version: the sandboxed mount this was built against couldn't
reliably delete PGlite's on-disk files; a real OS temp dir doesn't have that
problem, and runtime data shouldn't live in the synced project folder
regardless).

Demo login, once the dev server is up:

```bash
curl -i -c /tmp/cookies.txt -X POST http://127.0.0.1:3001/auth/office/login \
  -H 'content-type: application/json' \
  -d '{"email":"rex@antenas-piloto.pt","password":"proof-pass-123"}'

curl -b /tmp/cookies.txt http://127.0.0.1:3001/templates
```

## Proving the Phase 1 exit criterion

> "two tenants' data provably isolated, one offline mutation round-trips
> correctly after an app kill" — CLAUDE.md

```bash
npm run proof:phase1        # from the repo root
```

`test/phase1-proof.mjs` spawns the API as a real child process against a
throwaway data directory and, entirely over HTTP (no internal function
calls):

1. Logs in as two different tenants' office users, plus a paired technician
   device — both auth flows.
2. Has tenant A create a private template, then confirms tenant B's
   `GET /templates` cannot see it while both tenants can see the shared
   system templates — tenant isolation, through the API surface, not just
   the DB layer (`verify-schema.mjs` already covers that layer separately).
3. Confirms the `ited_full` test_protocol activation gate rejects an
   unverified version with `422 unverified_test_protocol` and accepts a
   verified one — the same gate `seed.sql`/`verify-seed.mjs` exercise at the
   DB layer, here exercised through the route.
4. Submits a trivial `checklist_item.update` sync mutation, confirms it
   applied, **SIGKILLs the running server process**, restarts it against the
   same on-disk data, and replays the identical mutation batch — confirming
   `already_applied` (idempotent, no double-effect) and that a genuinely new
   mutation submitted after the restart still works. This is the actual
   "killed-mid-sync app restart" scenario, not a simulation of one.

21 checks, all passing as of this writing. Re-run after touching `src/db.ts`,
any route, or the sync mutation handler.

## What's deliberately not here yet

Everything Phase 2+ per `CLAUDE.md`: quotes/BOM, dispatch gate, execution
steps, photos, close-out, compliance (REF/termo/deadlines), dashboard, the
web/mobile clients themselves. `GET /sync/_debug/checklist-item/:id` in
`routes/sync.ts` is proof-only scaffolding (not in `04-API-SPEC.md`) — it
exists because PGlite is single-writer and the proof script can't safely
open a second connection to the same on-disk data while the server holds it
open, so verifying a mutation's effect has to go through the API like
everything else. Fine to delete once a real `GET /jobs/:id/readiness` exists
to serve the same purpose.
