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

## What's deliberately not here yet (as of Phase 1)

Everything Phase 2+ per `CLAUDE.md`: quotes/BOM, dispatch gate, execution
steps, photos, close-out, compliance (REF/termo/deadlines), dashboard, the
web/mobile clients themselves. `GET /sync/_debug/checklist-item/:id` in
`routes/sync.ts` is proof-only scaffolding (not in `04-API-SPEC.md`) — it
exists because PGlite is single-writer and the proof script can't safely
open a second connection to the same on-disk data while the server holds it
open, so verifying a mutation's effect has to go through the API like
everything else. Fine to delete once a real `GET /jobs/:id/readiness` exists
to serve the same purpose.

## Phase 2 — the job loop

Built on top of Phase 1's foundations, per `05-phase2-job-loop.md`: the full
loop every tenant uses regardless of compliance profile.

- **Catalog, clients, equipment, suppliers** — trivial CRUD (`routes/catalog.ts`,
  `routes/clients.ts`, `routes/equipment.ts`), unblocking everything else's
  fixtures.
- **Quotes/BOM** (`routes/quotes.ts`) — `draft → sent → accepted` quote
  lifecycle, `quote_line` as the BOM, `PATCH /quotes/:id/lines`.
- **Job creation with checklist-snapshot resolution**
  (`domain/job-creation.ts`, called from `POST /quotes/:id/create-job`) —
  the one piece of Phase 2 logic that didn't already exist as a Phase 1
  pattern: resolving the template engine (built in Phase 1, unused until
  now) into `job.readiness_snapshot` / `execution_snapshot` /
  `test_protocol_snapshot`, written once and never re-read (architecture
  §5), plus materializing `job_checklist_item` rows and merging in any
  quote line not already covered by the resolved checklist.
- **Dispatch gate** (`domain/dispatch-gate.ts`, `POST /jobs/:id/dispatch`) —
  the four API-spec §5 conditions (checklist, van audit, equipment
  calibration, `ited_classification` review) as one pure function returning
  `{ok:true}` or `{ok:false, blocking:[...]}`; the route maps that to
  `200`/`409` and, on success, only flips `job.status` and echoes the
  snapshots already frozen at job-creation time — dispatch never
  re-resolves a template. Only reachable from `job.status = 'ready_check'`;
  a job that's already progressed past dispatch is rejected with
  `409 wrong_status` even if its (now-stale) checklist/van-audit/
  classification data would otherwise still satisfy the gate.
- **Execution steps, photos, test results** (`domain/execution-steps.ts`,
  `domain/test-results.ts`, `object-store.ts`) — `POST
  /jobs/:id/execution-steps/:step/complete`; photo bytes travel as a
  separate multipart `POST /jobs/:id/photos`, never through the JSON sync
  envelope; `POST /jobs/:id/test-results` computes `outcome` server-side
  against the job's frozen `test_protocol_snapshot`, via the same
  range/min/max evaluator (`packages/core/src/test-protocol-eval.ts`) the
  phone would use for instant client-side feedback. F13 (coax S/MATV, TT)
  and F14 (fibre) only, per §7's scoping note — F11/F12 stay in Phase 3.
- **Close-out** (`domain/closeout.ts`) — `POST /jobs/:id/complete` stamps
  `completed_at`; `POST /jobs/:id/closeout` is the technician-facing
  close-out write, and its request schema
  (`packages/core/src/closeout.ts`) genuinely has no `rework_cause` field —
  not a role check on a shared schema, a field that does not exist on the
  technician route at all. `rework_cause` is office-only, via `PATCH
  /jobs/:id/closeout/rework-cause`.
- **Sync, extended to five mutation types** — `packages/core/src/sync.ts`'s
  `SyncMutation` is now a discriminated union: `checklist_item.update`
  (Phase 1) plus `execution_step.complete`, `test_result.record`,
  `closeout.submit`, `van_audit.record`. Every handler in
  `routes/sync.ts` follows the exact same idempotency pattern Phase 1
  proved: look up `applied_mutation` by `(client_mutation_id, tenant_id)`
  first; if found, return the stored result with `already_applied` and do
  nothing else; if not found, apply, then insert the result. `GET
  /sync/bootstrap` is real now too — for the technician's assigned,
  in-flight jobs, it returns the frozen snapshots, current checklist
  status, the tenant's latest van audit, and calibration status for any
  equipment the resolved test protocol references, the full set a phone
  needs to operate offline from a cold start.

### Two deliberate v1 scope decisions from the dispatch stage

Named here so they're a visible decision, not a gap someone has to
rediscover:

1. **Van-audit coverage isn't scoped to a specific van.** No column links a
   job to the van it'll actually use, so the dispatch gate's van-audit
   condition (`domain/dispatch-gate.ts`) is interpreted tenant-wide: the
   tenant's single most recent `van_audit` (any `van_label`) must not be
   stale. A real fix needs `job.assigned_to`'s van modeled explicitly —
   out of scope for this phase.
2. **Calibration recording overwrites instead of superseding.** `POST
   /equipment/:id/calibration` (`routes/equipment.ts`) updates
   `equipment.calibration_*` columns in place rather than inserting an
   append-only history row, which is what architecture §7's
   evidence-retention spirit would actually call for. A future pass would
   add an `equipment_calibration` history table and derive the current
   columns from its latest row.

## Proving the Phase 2 exit criterion

> "a technician completes readiness → execution → close-out on the phone
> UI, offline, zero typed text" — `05-phase2-job-loop.md` §10

```bash
npm run proof:phase2        # from the repo root
```

`test/phase2-proof.mjs` is the same shape as `test/phase1-proof.mjs`,
extended rather than replaced: a real child-process server, a cookie-jar
`Session` per "device", client → quote → BOM → templates → accept →
create-job, an early 409 dispatch attempt, satisfying the gate (checklist
sync mutations, a van audit, office `ited_classification` review),
dispatch succeeding and a same-status re-dispatch attempt being rejected,
execution-step completion, a real multipart photo upload, test-result
capture against the real seed.sql-verified Tabela 6.12 limits (both via
sync mutation and the direct route), complete + technician close-out (and
confirming the technician route rejects `rework_cause`), and the same
SIGKILL-mid-sync-then-restart-then-replay scenario Phase 1 proved, this
time on `execution_step.complete` to confirm the sync infra generalizes
beyond the one mutation type Phase 1 exercised it against.

37 checks, all passing as of this writing. Re-run after touching
`domain/job-creation.ts`, `domain/dispatch-gate.ts`, any Phase 2 route, or
the sync mutation handlers.
