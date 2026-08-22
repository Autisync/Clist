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

## Phase 4 — cost intelligence

Per `07-phase4-cost-intelligence.md`: suppliers/prices, receipts (OCR-assisted,
human-confirmed), sourcing/pickup-plan, and the dashboard views — all thin
reads or human-gated writes over data the schema and Phase 1–3 already
produce. No new domain concept requiring its own gate the way dispatch/REF
did; the one rule this phase exists to enforce is the OCR→price boundary
below.

- **Suppliers & prices** (`routes/suppliers.ts`) — trivial CRUD for
  `supplier`, plus `GET /suppliers/:id/prices` and the direct manual-entry
  route `POST /suppliers/:id/prices`. `source` is hard-pinned to `"manual"`
  on this route regardless of what the request body says — `"receipt"`
  source only ever comes from the human `POST /receipts/:id/confirm` step.
  `supplier_price` holds **one current row per `(tenant, supplier, item)`**:
  on write, the existing row (if any) is `UPDATE`d in place — `prev_price`
  set to what was current a moment ago, `price`/`source`/`effective_at`
  overwritten — the same "overwrite, not supersede" v1 scope call
  `apps/api/README.md`'s Phase 2 section already names for equipment
  calibration.
- **Receipts** (`routes/receipts.ts`) — `POST /receipts` accepts a multipart
  photo, stores the bytes via the existing `ObjectStore` (unchanged, reused
  exactly as Phase 2/3 built it for job photos and REF PDFs), and runs it
  through `receipt-ocr-provider.ts`. **`receipt-ocr-provider.ts` now has a
  real vendor behind it — Veryfi — selected once at module load if
  `VERYFI_CLIENT_ID`/`VERYFI_CLIENT_SECRET`/`VERYFI_USERNAME`/
  `VERYFI_API_KEY` are all set (`apps/api/.env`, gitignored;
  `apps/api/.env.example` documents the variable names, no values), falling
  back to the original deterministic `FixtureReceiptOcrProvider` otherwise.
  **Choosing a vendor still does not by itself satisfy architecture §6's
  bar** — evaluating real accuracy against ~20 real Portuguese thermal
  receipts hasn't happened; what changed is that evaluation can now
  actually be run against live output instead of staying blocked on
  "nothing to test against." Verified working against the real Veryfi API
  directly before landing (a real `201` with a full parsed response, not
  just "the code compiles") — the HMAC-SHA256 request-signing scheme
  (`docs.veryfi.com/api/getting-started/authentication/`) is exact, not
  approximate. **A vendor outage/timeout degrades the receipt upload, it
  never fails it**: OCR failure (`ReceiptOcrError`, a 20s timeout,
  non-2xx, or malformed response) is caught in the route, the receipt is
  still saved (the image is already durably stored by that point) with
  `ocr_raw: {"ocr_failed": true}` and zero parsed lines, and the response
  carries `ocr_failed: true` so `apps/web`'s receipt-review UI shows an
  honest message instead of an unexplained empty list — uptime of receipt
  *capture* must not depend on a third party's uptime. **Every
  proof/smoke script that spawns this server explicitly strips the four
  `VERYFI_*` keys from the child process's environment** regardless of
  what the host shell has set, so automated runs are always against the
  deterministic fixture — fast, free, and never flaky on a real vendor's
  network. Parsed lines are matched to `catalog_item` by case-insensitive
  name/SKU; a line with no match gets `item_id = null` ("sem
  correspondência") and is inserted for office review, never dropped and
  never guessed at. **`POST /receipts` writes only `receipt` and
  `receipt_line` rows — never `supplier_price`.** `POST
  /receipts/:id/confirm` is the one human-gated write: given a set of
  `line_ids`, for each confirmed line that has a matched `item_id` and a
  receipt-level `supplier_id`, it writes `supplier_price` — using the exact
  same look-up-then-`UPDATE`-in-place-else-`INSERT` logic as the manual
  route above, so repeat confirmations of receipts for the same
  supplier+item overwrite the current row instead of accumulating duplicate
  "current" rows (a real bug an adversarial review caught and this pass
  fixed — the confirm route originally always `INSERT`ed). Unconfirmed
  lines, and confirmed lines with no item match, are left alone entirely —
  genuinely selective, not all-or-nothing.
- **Sourcing & pickup-plan** (`domain/sourcing.ts`, new routes on
  `catalog.ts` and `jobs.ts`) — ports of the prototype's settled algorithms
  (`fieldready-prototype.jsx`'s `sourcingOptions`, `openState`,
  `pickupPlan`), same sort keys, not redesigned. `GET
  /catalog-items/:id/sourcing` returns every supplier currently pricing
  that item, sorted by price ascending only. `GET /jobs/:id/pickup-plan`
  covers a job's still-`missing` mandatory materials, sorted by (items
  covered desc, currently-open-now desc, total price asc) — a different
  tie-break from plain sourcing, not a variant of the same one.
  `places-provider.ts` (open-now / distance) is the second fixture stub in
  this phase, same deferred-vendor-choice reasoning as the OCR provider —
  a hardcoded Lisbon-address map, no Google Places credentials anywhere.
- **Dashboard** (`routes/dashboard.ts`) — five thin-read routes
  (`v_first_time_fix_rate`, `v_hours_variance`, `v_readiness_correlation`,
  `v_price_alerts`, plus `recommended-actions`) selecting directly from the
  views the schema already ships; only `recommended-actions` turns numbers
  into sentences, as speced — no JS-side re-derivation of the underlying
  arithmetic anywhere else.

### Proving the Phase 4 exit criterion

```bash
npm run proof:phase4        # from the repo root
```

`test/phase4-proof.mjs` follows the same real-child-process, real-HTTP shape
as the other three proof scripts. It creates suppliers and prices, confirms
`GET /suppliers/:id/prices` reflects a seeded price rise with `prev_price`
recorded; uploads a receipt through the fixture OCR provider and confirms a
strict subset of matched lines, checking the resulting `supplier_price` rows
match exactly the confirmed set (matched-but-unconfirmed lines absent,
unmatched "sem correspondência" line untouched); checks `GET
/catalog-items/:id/sourcing` returns strictly price-ascending results; seeds
a 4-supplier pickup-plan fixture and asserts the order against a
hand-computed (coverage desc, open-now desc, price asc) expectation;
confirms `GET /dashboard/price-alerts` surfaces a real price rise with the
correct cheaper alternative supplier and `GET
/dashboard/recommended-actions` generates its supplier-switch sentence from
that live data; then, the same class of crash-recovery proof the other
three phases run — kills the server, writes `job.actual_hours` directly on
the same on-disk data while it's down (never two processes open against the
same PGlite data directory at once), restarts the server, and confirms `GET
/dashboard/hours-variance` and `GET /dashboard/first-time-fix-rate` match
independently hand-computed raw-SQL expectations on the live restarted
server, not a cache.

29 checks, all passing as of this writing. Re-run after touching
`domain/sourcing.ts`, `routes/suppliers.ts`, `routes/receipts.ts`,
`routes/dashboard.ts`, `receipt-ocr-provider.ts`, or `places-provider.ts`.

**On the 30-real-jobs trust bar** (PRD / `CLAUDE.md`'s Phase 4 entry): that
gate is about whether the dashboard's *conclusions* are worth trusting
(first-time-fix rate, hours variance, price alerts computed over a
realistic volume of real closed jobs), not about whether the code exists.
The routes, views, and proof above are real and green today against seeded/
fixture data; nothing in this pass claims the dashboard's numbers mean
anything yet in production — that's a data-volume question for after
rollout, not an engineering one this commit can shortcut.

## Supabase-native migration — §6 Step 1

Design: `08-supabase-native-migration.md`. Not live, not wired to anything —
this is new, parallel infrastructure standing entirely apart from the
PGlite-backed system above, which remains the system of record until a
later `§6` step cuts real traffic over, slice by slice.

`supabase/schema.sql` is a faithful derivative of `../../03-schema.sql`
against a real Supabase Postgres project, with exactly the identity/RLS
changes the design doc's trust-model shift requires (browser talks to
Postgres directly; RLS is the *only* boundary, not backed up by a Fastify
layer that already decided). It also documents and fixes one real gap the
design doc's own §8 left open: `app_user.id == auth.uid()` was reasoned
only for office users — a technician never has a login of their own under
this design (only their *paired device* does), so `app_user` keeps its own
independent id, and a nullable `auth_user_id` column carries the
office/owner login link instead. See the file's own header and §2 comments
for the full reasoning, including why `fn_current_tenant_id()` needs a
`no force row level security` carve-out on exactly two tables to avoid a
chicken-and-egg identity-resolution failure.

`supabase/verify-schema-supabase.mjs` is the equivalent of `verify-schema.mjs`
run against the real project instead of PGlite — same checks (tenant
isolation, fail-safe with no identity, system-template cross-tenant
visibility, the activation gate, REF/termo reconciliation, dashboard views,
full RLS coverage), rewritten around `auth.uid()` instead of
`current_setting`, plus the checks that have no equivalent under the
current design at all — a **revoked device with a still-valid token**
being denied by `fn_current_tenant_id()`'s explicit `revoked_at is null`
re-check (§3 calls this out as new and required, not optional), and, after
the adversarial review below, its sibling for office/owner users: a
**deactivated office account with a still-valid token** denied by the same
function's `active` re-check. 24/24 checks passing as of this writing.

**An adversarial multi-agent security review of the first draft found two
critical and three high-severity real holes**, each independently
reproduced against a real Postgres RLS engine before being reported, not
assumed from reading the SQL:

- **Critical** — `template`/`template_version`'s original single USING/WITH
  CHECK policy covering every command let any tenant session UPDATE-hijack
  a *system-layer* template into their own tenant, DELETE any system
  template outright, or INSERT a fabricated `template_version` onto a
  seeded system protocol and self-satisfy the verified-by activation gate.
  Fixed by splitting each table into per-command policies — SELECT keeps
  the system-row exception, INSERT/UPDATE/DELETE never do, so a system
  template is only ever writable by a role that bypasses RLS entirely.
- **High** — `fn_current_tenant_id()`'s office branch never rechecked
  `app_user.active`, unlike the technician branch's `revoked_at` recheck —
  a deactivated office/owner account kept full tenant access until its
  token happened to expire on its own. Fixed to match.
- **High** — the five dashboard views had no `security_invoker = true`
  (PG15+), so their real cross-tenant safety depended on an unstated,
  unverified attribute of whichever role owned them. Fixed by adding it to
  all five, making RLS-through-views unconditional rather than an
  assumption.
- **High** — nothing tied `technician_device.tenant_id` to the tenant of
  the `app_user` row its `user_id` references, so a mismatched pairing
  would have silently resolved a device's session to the wrong tenant.
  Closed with a new `fn_technician_device_tenant_guard` trigger, same
  "one place for a mistake to hide" reasoning as `fn_current_tenant_id`
  itself.

Six more medium/low findings (an asymmetric auth-user cleanup gap between
this file and `verify-office-auth.mjs`, duplicated helper code between the
two scripts, a dashboard check that asserted row-count but not the actual
computed value, an RLS-coverage check that verified `relrowsecurity` but not
`relforcerowsecurity`, dead variables) were also fixed — the shared logic
between both verify scripts now lives in `supabase/verify-helpers.mjs`
specifically so a safety fix in one place reaches both. Every fix above has
its own new, passing check in the 24 — including exercising the exact
exploit each finding described, not just re-testing the original happy path.

```bash
npm run verify:schema-supabase   # from the repo root
```

**This is not like the other verify/proof scripts** — it connects to and
mutates a real, live external Supabase project (direct Postgres connection
as the `postgres` role, plus Auth Admin API calls to create/delete real
`auth.users` rows for the test fixtures). It needs
`SUPABASE_PROJECT_REF`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_DB_PASSWORD` in
`apps/api/.env` (never committed — see `.env.example` for the names only)
and is not wired into `npm run build` or any other aggregate script for
that reason. It resets only the specific objects `schema.sql` itself
creates before reapplying (never `drop schema public cascade`, which would
risk Supabase's own extension objects living in `public`), and sweeps real
Auth test users by their fixed `@device.fieldready.internal` email suffix
at the start of each run so failed/interrupted runs don't accumulate
cruft on the live project — verified empirically (see commit history), not
assumed.

### §6 Step 2 — office auth, exit criterion met

`supabase/verify-office-auth.mjs` proves the real claim §6 step 2 makes: a
real office user signs in via actual Supabase Auth (password, anon key —
the exact mechanism a browser uses, not a simulated GUC), and a real
PostgREST query through that session is RLS-scoped with zero Fastify route
in the path. **11/11 checks passing against the real project**, confirmed
twice in a row for idempotency, and confirmed the success-path cleanup
genuinely leaves no stray fixture rows behind (checked directly against the
live project, not just trusted from the script's own "OK" line):

```bash
npm run verify:office-auth-supabase   # from the repo root
```

Covers: real sign-in for two office users in two different tenants; wrong
password rejected by Supabase Auth itself; each user's real PostgREST
query against `client` and `tenant` returns exactly its own tenant's row,
nothing else — cross-tenant isolation holding over the actual HTTP surface
a browser uses, not a simulated one; an unauthenticated request (no
session at all) returns zero rows; and the anon key itself is confirmed
unable to call the Auth Admin API (403) — it carries no elevated power on
its own, RLS plus a valid session is the only way in.

`apps/web/src/lib/supabase/{env,client,server}.ts` are the browser/server
Supabase client factories for later slices — typechecked, not yet imported
from any real page (deliberately: nothing in `apps/web`'s existing
Fastify-backed login is touched by this work). Wiring an actual `/office/*`
login page to these is a later slice, not yet started.

### §6 Step 3 — one read path, one write path, exit criterion met

Chosen pair, per the design doc's own example: **job list read** (RLS
alone) + **`checklist_item.update` write** (RLS + an RPC function).

`supabase/rpc.sql` — new, applied on top of `schema.sql`, not merged into
it. One function so far, per Step 3's own scope: `rpc_checklist_item_update`,
a literal port of `apps/api/src/routes/sync.ts`'s `applyMutation()` case for
this mutation type — same `applied_mutation` lookup-then-apply-then-insert
sequence, same result shape. Runs `SECURITY INVOKER` (the default, unlike
`fn_current_tenant_id()`) — deliberately: the function exists only to
preserve atomicity/idempotency across what would otherwise be several
separate client calls, not to grant any privilege the caller didn't already
have. RLS on `job_checklist_item`/`applied_mutation` is what actually
restricts it, exactly as if the caller ran the statements directly.

`supabase/verify-step3-read-write.mjs` — **12/12 checks passing**,
confirmed twice for idempotency, against the real project over the real
HTTP surface (real Supabase Auth sign-in, real PostgREST reads, real
`supabase.rpc()` calls):

```bash
npm run verify:step3-supabase   # from the repo root
```

Covers: a technician's and an office user's real `job` list read each
return exactly their own tenant's one job; the RPC's first call applies the
update (independently confirmed against the raw table, not just trusted
from the RPC's own response); replaying the identical
`client_mutation_id` returns `already_applied` with no double-insert into
`applied_mutation` — the client-observable half of the SIGKILL-mid-sync
guarantee the four `proof:phaseN` scripts prove by actually killing a
process; here there's no separate server process to kill (the "server" is
Supabase's own managed Postgres), so this proof covers the half specific to
this application's design — a client retrying after not getting a response
gets the recorded result, not a double-effect — while crash-safety of the
transaction itself is a platform guarantee inherited from Postgres, not
re-derived; a cross-tenant write attempt is rejected as `item_not_found`
(RLS makes "doesn't exist" and "isn't yours" indistinguishable, avoiding an
existence leak) and independently confirmed to have had zero effect on the
real row; an invalid status value and an unauthenticated caller are both
rejected.

Writing this proof script found and fixed a real bug in itself, worth
naming since it's the same class of mistake the earlier security review
caught in the schema: a first draft's cleanup helper swallowed every
step's error with a blanket `.catch(() => {})` and never explicitly
deleted `technician_device`/`app_user` test rows, silently leaving 4 stray
tenant rows on the real project after two "all checks passed" runs —
caught by checking the live project directly rather than trusting the
script's own report, fixed by making every cleanup step log a failure
instead of hiding it and deleting `technician_device` before the auth users
it references (which has no cascade, by design).

### §6 Step 4 — the remaining sync mutations + rpc_dispatch_job, exit criterion met

`supabase/holidays.sql` — replaces the `date-holidays` npm dependency
entirely for F17 statutory-deadline math: a `pt_holiday` reference table
(117 rows, national public holidays 2024–2032) plus `fn_is_working_day`/
`fn_add_working_days`, a faithful SQL port of
`packages/core/src/deadlines.ts`. The seed data was generated by running
the real, already-installed `date-holidays` package day-by-day (not
hand-typed), verified against the exact real disagreement
`phase3-proof.mjs` already established for the TS implementation
(2026-04-01 + 10 working days = 2026-04-16, correctly skipping Sexta-Feira
Santa). A first attempt at the generation script silently shifted every
date by one day (a timezone-ambiguous string reparse) — caught by
cross-checking against that already-verified date before trusting any of
it, not assumed correct.

`supabase/rpc.sql` grew five more functions: `fn_eval_test` +
`rpc_test_result_record`, `rpc_execution_step_complete`,
`rpc_van_audit_record`, `rpc_closeout_submit` (the one piece genuinely
dependent on `holidays.sql`), and `rpc_dispatch_job` (a literal port of
`dispatch-gate.ts`'s four-condition gate plus the route's status-flip
wrapper, closing the exact TOCTOU race the design doc names as the reason
to port this at all). `schema.sql` also gained `fn_current_app_user_id()`,
a sibling to `fn_current_tenant_id()` — several of these RPCs need to
record *who* performed an action, which nothing before Step 4 resolved.
`create_job_from_quote()` is deliberately still not here — genuinely more
complex (slugification, two template-coding conventions, checklist
materialization, quote-line merge) and gets its own slice.

**An adversarial security review of this slice found and got independently
verified 10 real issues**, two worth naming specifically:

- **High** — `rpc_closeout_submit` and `rpc_dispatch_job` both read the
  job row with a plain, unlocked `SELECT` before deciding whether to
  write. Two genuinely concurrent calls for the same job (a real
  double-tap, or the "resubmit before dispatch of a corrected note"
  scenario the closeout code's own comment describes as intended usage)
  could both observe the pre-write state and both act on it — silently
  inserting two `compliance_deadline` rows for one job, or letting a
  second dispatch attempt succeed against an already-dispatched job
  instead of correctly failing. Fixed with `SELECT ... FOR UPDATE` on both
  functions' initial read (the standard Postgres pattern for this exact
  race), plus a second, independent `WHERE status = 'ready_check'` guard
  on dispatch's status-flip as belt and suspenders. Proven with genuine
  concurrent calls via `Promise.all` — not just sequential replay, which
  is exactly what let this ship unnoticed the first time.
- **Medium** — `fn_eval_test`'s numeric cast accepted the literal string
  `"NaN"` as a valid Postgres `numeric` value (comparing as greater than
  everything) instead of raising, so it silently returned `pass`/`fail`
  instead of `evalTest()`'s `pending` for that exact input — a compliance-
  relevant divergence with no earlier validation layer to catch it.
  Confirmed empirically (`'NaN'::numeric::text` always normalizes to
  `'NaN'` regardless of input casing, and does **not** affect
  `'Infinity'`, which JS's `Number()` also treats as a real comparable
  value, not NaN) before fixing.

Six more findings, all fixed: a low-severity ordering divergence in
`rpc_dispatch_job`'s instrument-id collection (`array_agg(distinct ...)`
sorts by value rather than preserving first-appearance order — currently
unreachable, since nothing populates `instrument_id` yet, but fixed ahead
of that); and four real test-coverage gaps in `verify-step4-rpc.mjs`/
`verify-holidays.mjs` — `rpc_van_audit_record`'s idempotent replay was
never tested at all (every other sync-mutation RPC had this check),
`fn_current_app_user_id()`'s **office** identity branch had zero coverage
anywhere in the whole Supabase-native suite (every RPC call in every prior
script went through a technician session only), the dispatch-success check
never verified the response actually carried the three snapshot fields it
exists to return, and the holiday seed data was only spot-checked on 2 of
117 dates.

`supabase/verify-step4-rpc.mjs` — **27/27 checks passing**, confirmed
twice for idempotency, zero stray rows confirmed directly against the live
project (a real ordering bug in this script's own cleanup — `job` rows
referencing `ited_classification_by` blocking the office auth-user's
cascade delete — was found and fixed the same way Step 3's was):

```bash
npm run verify:holidays-supabase   # from the repo root — apply/verify holidays.sql standalone
npm run verify:step4-supabase      # the full RPC surface
```

One evolving fixture (a non-basic tenant's job walked through all four
dispatch-gate conditions being blocked at once, then cleared one at a time
via the *other* new RPCs, then dispatched, then re-dispatch correctly
rejected; a basic tenant's job proving the ited-classification condition
is correctly skipped; cross-tenant dispatch attempts rejected as
`not_found`) plus a dedicated third job for the two genuine-concurrency
tests above. `supabase/verify-holidays.mjs` — **8/8 checks**, including a
full content diff of all 117 seeded rows against a fresh regeneration from
`date-holidays` (not just a row count) and confirmation that a duplicate
national holiday is actually rejected by the unique index.

### `rpc_create_job_from_quote()` — the last of the six named RPCs, exit criterion met

Port of `job-creation.ts`'s `createJobFromQuote()` plus
`routes/quotes.ts`'s `POST /quotes/:id/create-job` wrapper — quote
validation, collision-safe `JOB-XXXX` code generation, template resolution
across both coding conventions (`readiness_<slug>`/`execution_<slug>` by
code, `test_protocol` by inferred network type), checklist materialization,
and quote-line merge with covered-item dedup, all in one atomic function.
Two new helpers: `fn_slugify` (ports `slugify()`'s diacritic-stripping) and
`fn_infer_network_type` (the same keyword-priority heuristic as the TS
version).

**A security review of this slice found and independently verified 10
real issues, the most important being a genuine correctness bug in
`fn_slugify` itself.** Its first draft used Postgres's `unaccent`
extension, verified against 5 real test strings and apparently correct —
but the review found real Portuguese business text where it silently
diverged: `unaccent()` *expands* certain characters into extra ASCII
letters (º/ª, the ordinal indicators in "2º andar"/"nº 5", → `"o"`) where
the real `slugify()` — NFD-normalize, then strip only the Unicode
combining-marks block — leaves them untouched and they fall through to
become a hyphen instead. Since the resolved slug feeds directly into the
`readiness_<slug>`/`execution_<slug>` template lookup, this would have
silently resolved a *different* (or missing) template for any job whose
title contained a floor number or ordinal — exactly the kind of silent
divergence this migration exists to avoid, in genuinely common PT business
text, not an exotic edge case.

Fixed properly, not patched around: `fn_slugify` now uses Postgres's
native `normalize(text, NFD)` (built in since PG13, no extension needed)
to replicate the *actual* JS algorithm literally instead of approximating
it with a different one. Re-verified against 18 real strings this time —
every divergence the review found (º/ª, ß, œ, æ, ł, dotless ı) plus
digits-only, punctuation-only, empty-string, already-hyphenated, and
non-Latin scripts — all byte-for-byte identical to the real `slugify()`
output, and the `unaccent` extension dependency is gone entirely.

Five more findings fixed, all real test-coverage gaps: the JOB-code
20-attempt collision path had never been forced (fixed by pre-occupying
the entire `JOB-1000`–`JOB-9999` space in one batched insert and confirming
`code_collision` comes back correctly); the tenant-layer-preferred-over-
system template resolution had never been given a real second candidate to
choose between (fixed with a competing system-layer template sharing the
same code); the `qty`/`mandatory` default-coalescing had zero coverage
(fixed with a checklist item omitting both keys entirely); and the
cross-tenant basic-profile test only checked the compliance gate, not
whether tenant A's own templates could leak into tenant B's job (fixed
with real assertions on `has_execution_snapshot` and tenant B's actual
`job_checklist_item` rows — correctly distinguishing the shared
system-layer template, which legitimately *should* resolve for tenant B,
from tenant A's own tenant-layer one, which must never leak).

`supabase/verify-create-job.mjs` — **19/19 checks passing**, confirmed
twice for idempotency, zero stray rows (including the one fixture — a
competing system-layer template — that isn't tenant-scoped and needed its
own explicit cleanup):

```bash
npm run verify:create-job-supabase   # from the repo root
```

All six RPCs the design doc's §4 names are now built and proven: the five
sync mutations and `rpc_dispatch_job` (both from earlier in Step 4) and
`rpc_create_job_from_quote` (this slice). Remaining per `§6`: cutover of
the rest of the surface table-by-table (step 4's broader scope, now that
RPC authoring is complete) and final cutover (step 5) — wiring `apps/web`
to call these instead of Fastify, not further RPC authoring.
`apps/api/src/db.ts`, every existing route, and `03-schema.sql` itself
remain untouched by all of this work.

## Fastify→real-Postgres swap — `db.ts` no longer uses PGlite

`src/db.ts`'s own original comment anticipated this exact change: "Swapping
to a real Postgres server for production... means changing this file's
connection setup only; every query, policy, and trigger stays identical."
That's exactly what happened — PGlite (explicitly a Phase 1 stand-in, an
in-process WASM Postgres persisting to an on-disk directory) is replaced
with a real `pg.Pool` connection. Not a new external resource: the same
Supabase Postgres project the Supabase-native migration above already
proved against, connected to in a completely different way — a plain,
trusted-backend connection as the `postgres` role (no RLS, no anon key
involved at all), scoped to its own dedicated schema (`fastify_api` by
default, override with `FASTIFY_DB_SCHEMA`) so this classic system's tables
can never collide with the real, RLS-governed production data already
live in `public`.

What actually changed, and why:

- **Connection**: `new Pool({ host: db.<project-ref>.supabase.co, user:
  "postgres", ..., options: "-c search_path=<schema>" })`, built from the
  same `SUPABASE_PROJECT_REF`/`SUPABASE_DB_PASSWORD` `.env` values Step 2's
  `verify-office-auth.mjs` already used for a different purpose — no new
  secret to provision.
- **Schema application is now idempotent against a real, persistent
  server** rather than "does this fresh temp dir have a `tenant` table
  yet": `getDb()` checks `information_schema.tables` for the schema's own
  `tenant` table before applying `03-schema.sql`/`seed.sql`/Phase 1
  fixtures, so a restarted server reconnects to data that already survived
  it (the exit criterion every phase proof already required) for the same
  ordinary reason any long-lived server does — it just never stopped
  running — rather than because an on-disk file happened not to move.
- **One deployment-specific substitution inside an otherwise byte-identical
  `03-schema.sql`**: its one `grant usage on schema public to
  fieldready_app;` line becomes `grant usage on schema <FASTIFY_DB_SCHEMA>
  to fieldready_app;` — the only place the DDL text differs at all.
- **A grant PGlite never required, verified empirically before relying on
  it**: Supabase's `postgres` role can `SET LOCAL ROLE` to its own built-in
  roles (`authenticated`/`anon`/`service_role`) with no explicit grant, but
  *not* to a brand-new custom role like `fieldready_app` without one —
  confirmed directly against the real project (`SET LOCAL ROLE` failed
  with "permission denied" until `grant fieldready_app to postgres;` was
  added as a one-time step during first boot). A traditional standalone
  Postgres server, connected as whichever role created `fieldready_app` in
  the first place, wouldn't need this at all.
- **Date-column type parity**: `pg`'s default parser for `date` (OID 1082)
  returns a JS `Date`, same as PGlite actually does (see the bug below) —
  pinned back to a raw `'YYYY-MM-DD'` string via
  `pg.types.setTypeParser(1082, (v) => v)` so nothing downstream has to
  care which driver is running underneath it. `numeric` and `timestamptz`
  already round-trip identically in both drivers — no fix needed there.
- **Manual transaction handling**: `pg.Pool` has no built-in
  `.transaction()` helper, so `withTenant()` now does its own
  `BEGIN`/`SET LOCAL role`/`SET LOCAL app.current_tenant_id`/`COMMIT`, with
  `ROLLBACK` on any thrown error, on a dedicated checked-out client
  (`SET LOCAL` is connection-scoped) that's always released back to the
  pool. A genuine, positive side effect: concurrent requests from
  different tenants now run on separate real connections instead of
  serializing through PGlite's single embedded instance.
- **`PGliteTx` renamed to `DbTx`** (mechanical, mirrored across all 15
  consuming files — `domain/*.ts`, `routes/*.ts`) — it was always a purely
  structural `{query, exec}` type, never actually PGlite-specific, and now
  isn't even nominally so. `fixtures.ts`'s `seedPhase1Fixtures` signature
  updated the same way.

**A real, pre-existing bug found as a byproduct, not the point of this
change**: the type-parity investigation above required confirming exactly
what PGlite hands back for a `date` column, which meant actually querying
one directly rather than trusting `src/db.ts`'s own prior comment — that
comment was wrong. PGlite parses `date` into a JS `Date` object, not a
plain string. `domain/dispatch-gate.ts`'s calibration-expiry check compared
that value to a string with a bare `<`, which coerces the `Date` through
its default `toString()` (a locale string), never `toISOString()` — so the
dispatch gate's condition (c) had never actually detected an expired
instrument, for any date, since Phase 2. Found while porting the same
comparison to Supabase's `rpc_dispatch_job` (a pure-SQL date comparison
with no JS coercion pitfall to hit) and noticing the two implementations
disagreed. Fixed with an explicit `toIsoDate()` normalizer regardless of
which shape a driver hands back (see `dispatch-gate.ts`), and
`phase2-proof.mjs`'s own check for this condition — previously
"vacuously satisfied" (no equipment/calibration data existed to actually
exercise it) — now creates real expired-then-renewed calibration data and
confirms the gate blocks, then un-blocks, for real. Fixed and proven
independently of the Postgres swap itself (commit `7fc2f6b`), since it's a
real correctness bug the swap's investigation happened to surface, not a
consequence of the swap.

**Proof scripts updated for the same reason, mechanically**: every
`test/phase*-proof.mjs` plus `apps/web/test/smoke.mjs` used to get a truly
clean slate by `rmSync`-ing its own dedicated on-disk PGlite directory
before spawning the server; now that `db.ts` persists into a real, shared
Postgres project, "clean slate" for a proof run means dropping that
script's own dedicated schema instead (`fastify_api_proof_phase1` /
`_phase2` / `_phase3` / `_phase4` / `fastify_api_smoke_web` — never the
bare `fastify_api` real local dev uses) via the new shared
`test/db-reset.mjs` helper, still never touching `public`. The two proof
scripts that reach into the database directly mid-run (phase2's
`instrument_id` snapshot injection, phase4's `actual_hours` write, both for
data with no HTTP write path by design) now do it through a real `pg`
connection into that same schema instead of opening a PGlite file. Every
proof script still gets its own dedicated port and schema, so all five can
run independently or back-to-back exactly as before.

**Env**: `SUPABASE_PROJECT_REF`/`SUPABASE_DB_PASSWORD` (already required by
Step 2) now double as this connection's credentials too — no new secret.
Optional `FASTIFY_DB_SCHEMA` overrides the default `fastify_api` schema
name. `dev`/`start`/every `proof*` script now load `apps/api/.env` via
Node's `--env-file` (previously unnecessary — PGlite needed no
credentials at all).

**Re-verified, not assumed**: `npm run build` (root — all three
workspaces), `proof:phase1` (21/21), `proof:phase2` (37/37, including the
real, non-vacuous calibration test above), `proof:phase3` (37/37),
`proof:phase4` (29/29), and `smoke:web` (23/23) all pass against the real
Postgres-backed server — identical counts to every prior pass, now with
zero PGlite involvement anywhere in `apps/api`.

**What this unlocks**: `apps/api` can now be deployed anywhere that can
reach the public internet on port 5432 (Fly.io, Render, a small VM — see
`apps/web/VERCEL.md`'s remaining-gap note) instead of needing a
long-running process with a writable local disk. Playwright PDF generation
and Veryfi OCR still need a real server process (not Vercel's serverless
functions), but the database itself is no longer the reason.

## Supabase-native migration — §6 Step 5: office job-detail cutover

`apps/web`'s `/office/jobs/:id` page (all three tabs — Readiness, Execução,
After-action report) now calls Supabase directly for every read and every
write except photo upload, matching `/office/jobs`'s own earlier cutover.
Reads go through `createSupabaseServerClient()` (job row, client name,
`v_job_readiness`, `job_checklist_item`, each a plain `.from(...)` query —
no new RPC needed for these, RLS alone is the boundary, same as the job
list page). Writes go through `supabase.rpc(...)` calls from the browser,
one per action:

| Action | RPC | New this slice? |
|---|---|---|
| Checklist toggle | `rpc_checklist_item_update` | no (§6 Step 3) |
| Dispatch | `rpc_dispatch_job` | no (§6 Step 4) |
| Execution step complete | `rpc_execution_step_complete` | no (§6 Step 4) |
| Test result record | `rpc_test_result_record` | no (§6 Step 4) |
| Complete (dispatched→testing) | `rpc_job_complete` | **yes** |
| Close-out submit | `rpc_closeout_submit` | no (§6 Step 4) |
| Rework-cause (office-only) | `rpc_closeout_set_rework_cause` | **yes** |
| Photo upload | — (stays Fastify) | n/a |

**Two new RPCs, for two different reasons — neither was in §4's original
six named candidates, because neither route existed as a distinct write
concern until this slice actually tried to port it:**

- **`rpc_job_complete(p_job_id uuid)`** ports `POST /jobs/:id/complete`
  (`routes/jobs.ts`) — a genuinely separate transition from
  `rpc_closeout_submit`, not a duplicate of it: the office two-step flow's
  first step (dispatched/in_progress/testing → testing, stamps
  `completed_at`), distinct from close-out's own later
  testing/closed transition. Qualifies for an RPC on the same grounds
  `rpc_dispatch_job` already did (§4): a read-decide-write sequence (status
  precondition, conditional `compliance_deadline` insert) a client observing
  it through several separate calls could race. Added `FOR UPDATE` the
  Fastify route never had — not a literal port of a known-safe original but
  a fix for the same TOCTOU shape `rpc_dispatch_job`'s own comment already
  named and closed for its sibling function; reproducing the unlocked read
  here would have been reproducing a known bug class, not preserving
  intended behavior.
- **`rpc_closeout_set_rework_cause(p_job_id uuid, p_rework_cause text)`**
  ports `PATCH /jobs/:id/closeout/rework-cause`. Expected going in that this
  would be a plain client-side `.update()` (no atomicity concern) — turned
  out to need an RPC anyway, because `rework_cause_set_by` must be resolved
  server-side from the calling session the same way every other attribution
  column in this codebase already is (`ited_classification_by`,
  `updated_by`, `closed_by`, `completed_by`, `performed_by`): a plain RLS-
  scoped write would let the client supply that value itself, letting any
  caller claim any `app_user` id — exactly the kind of gap RLS-as-sole-
  boundary is supposed to close, not reopen. `fn_current_app_user_id()` is
  `SECURITY DEFINER` precisely so a `SECURITY INVOKER` RPC can resolve it
  safely (`schema.sql`'s own comment on that function); technician role-
  gating from the Fastify version is deliberately not ported, since no
  technician session can reach this at all until technician auth is
  migrated to Supabase (still a later, separate slice) — flagged in the
  function's own comment as a real gap to close then, not silently relied on.

`apps/api/supabase/apply-rpc.mjs` (new) re-applies the whole of `rpc.sql`
idempotently (`create or replace function` throughout) — `npm run
apply:rpc-supabase` from the repo root — the tool used to push both new
functions to the real project.

**Proven, not assumed**: `apps/api/supabase/verify-job-complete.mjs` (new,
**20/20 checks passing**, `npm run verify:job-complete-supabase`) — both
new RPCs, over real HTTP with real Supabase Auth sign-ins, deliberately
*not* re-deriving the dispatch gate or `fn_add_working_days`' holiday-aware
arithmetic (both already proven elsewhere): the wrong-status conflict, RLS
correctly returning `not_found` (not a 403) for a cross-tenant job id on
both new RPCs, the happy path with a real `termo` `compliance_deadline` row
inserted exactly once, no duplicate on a retried call, the `basic`-profile
tenant completing with *no* deadline row, an unknown job id returning
`not_found` rather than an error, and — independently, via a direct
superuser read, not just the RPC's own echoed return value —
`rework_cause_set_by` actually resolving to the signed-in office user's own
`app_user` row.

Also verified live, end to end, through the real browser against the real
Supabase project (a temporary tenant/job/user provisioned and torn down
afterward, not committed as a fixture): sign-in, checklist toggle
(readiness % updating live), a blocked dispatch attempt rendering the
server-computed blocking reasons (`van_audit_stale` +
`ited_classification_unreviewed`), a successful dispatch once both were
satisfied directly via SQL, execution/complete/close-out/rework-cause all
the way through, and a final independent SQL read confirming
`rework_cause_set_by` and the `termo` `compliance_deadline` row both landed
correctly — the same proof this section's automated script already gives,
just also seen working in an actual rendered page.

**A four-dimension adversarial review of this whole slice (SQL race-safety,
RLS/tenant isolation, client-wiring parity, completeness/regression) found
and fixed three real issues, one of them high-severity:**

- **High — `rpc_checklist_item_update` (§6 Step 3, not new this slice) never
  set `updated_by`/`updated_at` at all**, a faithful port of `sync.ts`'s
  `applyMutation` for this mutation type (which never set them either) but a
  real, user-visible regression for the office UI specifically: the
  office's own direct `PATCH /jobs/:id/checklist/:item_id` route always
  stamped both. Wiring the office job-detail page to this *shared* RPC
  instead (this slice) is what first makes that gap bite — the office had
  attribution before and silently loses it now. Fixed in the RPC itself
  (benefiting the phone's sync path too, which had the same latent gap),
  proven with a new assertion in `verify-step3-read-write.mjs` that
  `updated_by` resolves to the calling session's own `app_user` id.
- **Medium — the four other office-triggered RPC calls in `job-detail.tsx`
  only checked `data.status === "rejected"`**, never the replay path: every
  RPC's idempotency branch returns the *original* stored result with
  `status` overwritten to `already_applied` but its original `reason` key
  (present only on a rejection) left untouched, so a hypothetical retry of
  a `client_mutation_id` whose first attempt was rejected would look like a
  success. Not reachable today (`job-detail.tsx` generates a fresh
  `crypto.randomUUID()` per call, never reusing one), but the check is
  fixed to test for `data.reason` instead, which is correct regardless.
- **Medium — `rpc_closeout_set_rework_cause`'s emptiness guard used bare
  `trim()`**, which in Postgres strips only the ASCII space character, not
  tab/newline/CR — a whitespace-only value using either would have slipped
  through as "non-empty". Fixed with `!~ '\S'` (no non-whitespace character
  present, correct for any whitespace), proven with a new tab+newline-only
  test case the original space-only test case would not have caught.
- Two low-severity consistency findings on the same function, both fixed:
  it never resolved/guarded `fn_current_tenant_id()` (every sibling RPC
  does, for an early, unambiguous error — RLS alone already made this safe,
  the guard is diagnostic, not a closed hole) and dropped the Fastify
  route's `technician_cannot_set_rework_cause` role check (justified at the
  time as "no technician Supabase session exists yet" — true operationally
  but enforced by nothing). Re-added as a real `app_user.role` check inside
  the function, proven against a synthetic technician-role Supabase session
  built purely for this test (technicians don't get real Supabase sessions
  in the product yet — same pattern `verify-step3-read-write.mjs` already
  established for exercising this RLS boundary before it matters in
  practice).

Pre-existing gap, not introduced by this slice and not fixed by it: there
is still no UI control anywhere in `apps/web` for actually reviewing
`job.ited_classification` (PRD §7's "route to office review in the UI") —
the dispatch-gate blocking reason renders as text on this page, same as
before, but nothing lets an office user act on it from here. Worth a future
slice; out of scope for this one.
