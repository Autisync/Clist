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
npx playwright install chromium  # once, for REF PDF generation (Phase 3)
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

## Phase 3 — compliance (F11/F12, F15–F18)

Per `06-phase3-compliance.md` §4 / `04-API-SPEC.md` §7: `POST /jobs/:id/ref`,
`PATCH /jobs/:id/ref`, `POST /jobs/:id/ref/generate-pdf`
(`routes/ref.ts`, `domain/ref.ts`). All three 403 for
`tenant.compliance_profile = 'basic'`, checked first inside the same
`withTenant` transaction the rest of the route runs in, same pattern
`domain/dispatch-gate.ts`/`domain/job-creation.ts` already use for reading
`tenant.compliance_profile`.

- **`domain/ref.ts`'s `populateFichaFields`** builds `ref_document.ficha_fields`
  from what the job already knows: installer from
  `app_user.professional_registration_number` via `job.assigned_to`,
  building address from `job.address` (falling back to `client.address`)
  plus `job.manual_edition` for "MANUAL ITED APLICÁVEL", and
  `cabos_instalados`/`outros_materiais` from a best-effort keyword match
  over `job_checklist_item` (`cat = 'material'`) labels and, when the job
  has a quote, `quote_line` descriptions — neither table carries a
  structured REF category (`catalog_item` has no category column at all),
  so this is genuinely best-effort: text that doesn't match a known keyword
  is left out rather than dumped into a catch-all bucket.
  `documentacao_facultativa`/`outras_identificacoes_relevantes` are always
  `""`, left for office editing via `PATCH /jobs/:id/ref`, which merges at
  the top level (any key present in the request replaces that key's whole
  value; keys omitted are untouched) rather than replacing the whole jsonb
  document.
- **The `fn_ref_termo_reconciliation` trigger** (`03-schema.sql` §10) is the
  only enforcement of the REF/termo `ref_id` match — `routes/ref.ts` does
  not duplicate that check; it catches the trigger's exception and
  translates it to a structured `422`, the exact pattern
  `routes/templates.ts`'s activation route already uses for
  `fn_activate_template_version_guard`.
- **PDF generation** (`domain/ref.ts`'s `renderRefHtml`/`renderPdfFromHtml`/
  `generateRefPdf`) renders `src/templates/ref.html` (real HTML/CSS, the
  real `ficha_fields` data interpolated and HTML-escaped, not a mock) via
  Playwright's `page.pdf()` against headless Chromium, and writes the bytes
  through the existing `ObjectStore` (`object-store.ts`, unchanged, reused
  exactly as Phase 2 built it for photos) — the key is saved to
  `ref_document.generated_pdf`. **No stack substitution needed here**:
  unlike PGlite standing in for a real Postgres server, headless Chromium
  was tried first and does launch cleanly in this sandbox (`npx playwright
  install chromium`, then a real `page.pdf()` call, both verified directly
  before writing `routes/ref.ts`) — `playwright` (`^1.62.1`) is a normal
  new `apps/api` dependency, not a workaround.

### F11/F12 — the two test protocols left over from Phase 2's F13/F14 scoping

`seed.sql` now seeds both, alongside F13/F14, as verified/activated
`test_protocol` template versions — the same activation gate
(`fn_activate_template_version_guard`), no bypass:

- **F12** (`coax_cc_tabela_6_7_6_9`) — real Tabela 6.7/6.9 numbers from
  `forms-and-procedures-spec.md` §3.4 / `ited-ref-mapping.md` §7A.3: 13.8/10.8 dB
  (coletiva/individual, 47–862 MHz) and 23.4/8.4 dB (individual only,
  950–2150 MHz). A normal `range`-type protocol, same shape as F13/F14.
- **F11** (`pares_cobre_tabela_6_1`) — the addendum research finding from
  `ited-ref-mapping.md` §7A.3 and `06-phase3-compliance.md` §2: Tabela 6.1
  isn't a numeric-limits table at all. It defers to the external EN 50173
  Classe E standard, evaluated by the cable certifying instrument's own
  pass/fail. Seeding a fake numeric threshold to fit the existing
  `min`/`max` shape would have been fabrication, so the schema grew a new
  `TestProtocolTest.dir` value instead — **`external_pass_fail`**
  (`packages/core/src/template.ts`) — carrying no `min`/`max`, just a
  `verified_source` citation that says outright no ITED-specific number
  exists for this network type. `packages/core/src/test-protocol-eval.ts`'s
  `evalTest` grew the matching branch: normalizes an externally-supplied
  `"pass"`/`"fail"` result straight through, no computation.
- `verify-seed.mjs` was generalized (06-phase3-compliance.md §2's explicit
  ask) from two hardcoded F13/F14 blocks into one loop over every active
  `test_protocol` version, so F11/F12 are checked by the same gate logic
  rather than a third and fourth copy-pasted block.
- `job-creation.ts`'s `inferNetworkTypeFromJobType` /
  `resolveActiveTestProtocolByNetworkType` now cover all four network
  types with no protocol-specific branching — the same resolution path
  F13/F14 already used in Phase 2.

### F16 — termo de responsabilidade tracking

`routes/termo.ts` / `04-API-SPEC.md` §7, same route-file-plus-domain-function
shape as `ref.ts`: `POST /jobs/:id/termo` (one per job — `job_id` is
unique on `termo_responsabilidade`), `PATCH
/jobs/:id/termo/recipients/:role` (read-modify-write over the `recipients`
jsonb array), and `POST /jobs/:id/termo/paper-copy-photo` (multipart,
through the same `ObjectStore` as job photos and REF PDFs). All three 403
for `compliance_profile = 'basic'`. A new, symmetric DB trigger,
`fn_termo_ref_reconciliation` (`03-schema.sql` §10), enforces the
`ref_id_field`/REF match from the termo-insert direction — the original
`fn_ref_termo_reconciliation` (Phase 3 F15) is untouched and still covers
the REF-insert direction. Both routes translate the same
`REF_TERMO_MISMATCH_REGEX` match into a `422`, never re-implementing the
check in application code. `verify-schema.mjs` §5b exercises the reverse
(termo-first) direction directly.

### F17 — statutory deadlines, real PT working-day calendar

`packages/core/src/deadlines.ts`'s `addWorkingDays` does real UTC-midnight
calendar stepping via `date-holidays` (the library `06-phase3-compliance.md`
recommends): skips weekends and only holiday entries with `type ===
"public"` — an `observance` like Carnaval is correctly *not* skipped, a
`public` holiday like Sexta-Feira Santa is. `domain/deadlines.ts` has two
insert paths, each firing exactly once per job:

- `insertTermoDeadline`, called from `domain/closeout.ts`'s
  `submitCloseout` and `routes/jobs.ts`'s `/jobs/:id/complete`, both guarded
  so it only fires the moment `completed_at` transitions from `null` (the
  office `/complete` route 409s on a second call rather than double-firing).
- `insertRefDeadline`, called from `routes/termo.ts` right after the termo
  insert succeeds — capped at one per job by `termo_responsabilidade.job_id`'s
  uniqueness.

`GET /compliance/deadlines?status=&due_before=` (`routes/compliance.ts`) is
the polling read a scheduled escalation worker would use to walk
`open → reminder_sent → warning_sent → overdue`; also 403s for
`compliance_profile = 'basic'`.

### F18 — rótulo

A plain `ref_document.rotulo_affixed` boolean, settable via the same
`PATCH /jobs/:id/ref` route F15 already built (`packages/core/src/ref.ts`'s
request schema now accepts `rotulo_affixed` alongside `ficha_fields` /
`attachments`, still requiring at least one field present).

## Proving the Phase 3 exit criterion

```bash
npm run proof:phase3        # from the repo root
```

`test/phase3-proof.mjs` follows the same real-child-process, real-HTTP
shape as `test/phase1-proof.mjs` / `test/phase2-proof.mjs`. It confirms
every F15–F18 route 403s outright for a `basic`-profile tenant (all seven
REF/termo/deadline routes, one proof step); walks REF creation, `PATCH`
(including `rotulo_affixed`), and real PDF generation through Playwright;
creates a termo, confirms the reconciliation trigger blocks a mismatched
`ref_id_field` and accepts a matching one from the termo-insert direction
(the new, symmetric half of the check F15 already proved from the
REF-insert direction); records termo recipients and a paper-copy photo
upload; and engineers a real disagreement between naive and holiday-aware
deadline math (naive 2026-04-15 vs. holiday-aware 2026-04-16, skipping
Sexta-Feira Santa) to assert both the termo and REF deadlines land on the
correct, holiday-adjusted date via `GET /compliance/deadlines` —
independently computed, not the same code path being tested twice.

37 checks, all passing as of this writing. Re-run after touching
`domain/ref.ts`, `domain/deadlines.ts`, `domain/closeout.ts`,
`routes/ref.ts`, `routes/termo.ts`, `routes/compliance.ts`, or
`packages/core/src/deadlines.ts`.
