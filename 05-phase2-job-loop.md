# FieldReady — Phase 2 design: the job loop

v1.0 · Read after `04-API-SPEC.md` and `apps/api/README.md`. Concrete enough to hand to
an agent directly, same bar as Phase 1 (architecture §8). Scope per `CLAUDE.md` /
`forms-and-procedures-spec.md` §5: **F02 → F03 → F05 → F06 → F07 → dispatch gate → F08 →
F09 → F10 → F19** — quote → BOM → job creation → readiness gate → dispatch → execution →
photos → close-out. Every tenant uses this loop regardless of `compliance_profile`.

*Exit criterion (PRD §8, restated concretely in §8 below):* a technician completes
readiness → execution → close-out on the phone UI, offline, zero typed text, matching
`fieldready-prototype.jsx`'s settled phone flow — proven the same way Phase 1 was, over
real HTTP, not asserted.

---

## 1. What Phase 1 already leaves in place

Nothing below needs new schema — `03-schema.sql` §6, §7, §8, §11 already have every
table this phase writes to (`quote`, `quote_line`, `job`, `job_checklist_item`,
`van_audit`, `equipment`, `job_photo`, `job_closeout`, `follow_up_action`). Phase 2 is an
API + business-logic phase, not a schema phase. Two things Phase 1 built that this phase
extends rather than replaces:

- **`withTenant` / `requireAuth`** (`apps/api/src/db.ts`, `auth/middleware.ts`) — every
  new route follows the exact pattern `templates.ts`/`sync.ts` already establish. Nothing
  new to design here.
- **The sync envelope** (`packages/core/src/sync.ts`, `apps/api/src/routes/sync.ts`) —
  Phase 1 registered exactly one mutation type (`checklist_item.update`) as
  `z.literal(...)`, deliberately trivial (architecture §8). Phase 2's first job is turning
  that into a real discriminated union (§6 below) and giving `checklist_item.update`
  actual domain meaning instead of an unconditional status write.

One thing to **delete**, not extend: `GET /sync/_debug/checklist-item/:id`
(`sync.ts` line 83) is proof-only scaffolding, and its own comment says so — retire it
once `GET /jobs/:id/readiness` (§3) exists to serve the same "did my mutation land"
purpose for the proof script.

## 2. Internal build order

Sequenced so each step is independently testable over HTTP before the next depends on it
— same discipline as Phase 1's proof script, just applied incrementally instead of in one
giant harness.

1. Catalog + client CRUD (trivial, unblocks everything else's fixtures)
2. Quote → BOM (§3)
3. Job creation from an accepted quote — **the one genuinely new piece of logic**: the
   checklist-snapshot resolution (§4)
4. Readiness read + checklist update, phone-writable (§5)
5. Van audit (§5a — **a gap in `04-API-SPEC.md`**, flagged and closed here)
6. Equipment/calibration CRUD (already fully speced, API spec §6)
7. Dispatch gate (§6a) — depends on 3–6 all existing
8. Execution steps, photos, test results (§7)
9. Close-out (§8)
10. Sync: extend the mutation union to cover 4–9, rebuild `/sync/bootstrap` for real (§9)

## 3. Quote → BOM (F01/F02)

`POST /quotes`, `PATCH /quotes/:id/lines`, `POST /quotes/:id/accept` are straightforward
CRUD against `quote`/`quote_line` — no gate, no snapshot logic, standard Zod-validated
insert/update inside `withTenant`. `quote.status` transitions `draft → sent → accepted`;
`accept` just stamps `accepted_at` and flips status, nothing else — job creation is a
separate, explicit call (next section), not an automatic side effect, so an office user
can accept a quote today and create the job next week without the two being coupled.

F01 (site survey) is a `checklist`-kind template like F03/F04 — its fields feed the quote
by hand for v1 (an office user reads the survey and fills the quote); auto-populating a
quote from a survey's structured fields is a real improvement but not required for the
loop to work end to end, so it's not in this phase's critical path.

## 4. `POST /quotes/:id/create-job` — checklist snapshot resolution

This is the one piece of logic in Phase 2 that doesn't already exist as a pattern
somewhere in Phase 1, because it's where the template engine (built, unused until now)
first gets exercised for real:

1. Resolve the tenant's **active** `checklist`-kind `template_version` whose `template.code`
   matches the job's `job_type` (convention: `readiness_<job_type_slug>`, e.g.
   `readiness_tdt_instalacao_nova` — matches the prototype's `JOB-2041` scope-split
   checklist). If the tenant has no template for that `job_type`, fall back to the system
   template of the same code (RLS on `template` already surfaces system rows
   cross-tenant, schema §12) — this is what makes a brand-new tenant usable on day one
   without authoring templates first.
2. Write the resolved `body.items[]` into `job.readiness_snapshot` (jsonb, verbatim —
   architecture §5's "resolved once, never re-read" rule) **and** materialize one
   `job_checklist_item` row per item, copying `cat`/`label`/`qty`/`item_id`/`scope`/
   `mandatory` straight across. The snapshot and the rows are not redundant: the snapshot
   is what the dispatch response replays to the client (API spec §5), the rows are what
   the office UI and sync mutations actually read/write against — same split
   architecture §5 already describes for other template kinds.
3. Do the same resolution for `execution_steps` → `job.execution_snapshot` and (if the
   tenant's `compliance_profile != 'basic'` and a matching `test_protocol` exists)
   `test_protocol_snapshot` — see §7's scoping note on why test protocols start in this
   phase, not Phase 3.
4. Merge in quote lines: any `quote_line` whose `item_id` isn't already covered by the
   resolved checklist becomes an additional `job_checklist_item` (`scope='job'`,
   `mandatory=true`) — this is what keeps a quote's actual BOM in sync with a generic
   template instead of the two silently diverging.
5. `job.quoted_hours`/`quoted_materials` copy from the quote; `job.status` starts at
   `ready_check`.

Implementation note: steps 1–4 belong in a pure-ish domain function
(`apps/api/src/domain/job-creation.ts`, taking a tx and returning the rows to insert) so
it's unit-testable independent of the HTTP layer — the dispatch gate (§6a) wants the same
treatment for the same reason.

## 5. Readiness + checklist (F03)

`GET /jobs/:id/readiness` — thin: `select * from v_job_readiness where job_id = $1` (view
already exists and is verified, schema §13) joined with the per-item detail from
`job_checklist_item`. This is the route that retires the Phase-1 debug endpoint.

`PATCH /jobs/:id/checklist/:item_id` — office-side direct write (`{status}`), for use from
the Next.js office UI. The **phone** never calls this directly — it goes through
`POST /sync/mutations` (§9), because the phone is offline-first by construction
(architecture §4) and a direct PATCH assumes connectivity the phone doesn't have.

### 5a. Van audit — closing a gap in `04-API-SPEC.md`

The spec document never lists an endpoint to *create* a `van_audit` row, only the
dispatch-gate check that reads one (API spec §5, condition 2). Add:

```
POST /van-audits              {van_label, issues: [{item_id?, label, note}]}
GET  /van-audits/latest?van_label=
```

`next_due_at` is computed server-side as `performed_at + tenant's audit interval`
(default 7 days, per `forms-and-procedures-spec.md` F04 — "weekly, configurable"; the
interval itself is a small addition to `tenant` if/when it needs to be configurable, a
constant until then).

## 6. Mutation registration and the dispatch gate

### 6a. `POST /jobs/:id/dispatch`

Implement the four conditions from API spec §5 as one function,
`apps/api/src/domain/dispatch-gate.ts`, returning either `{ok: true}` or
`{ok: false, blocking: [...]}` — the route just maps that to `200`/`409`. Keeping it a
pure function (input: job row + its checklist rows + latest van audit + equipment
calibration rows + tenant compliance profile; output: the blocking list) means it can be
unit-tested against fixtures without spinning up HTTP, the same way `verify-schema.mjs`
already tests trigger/view logic at the DB layer independent of any route.

On success, the response's `readiness_snapshot`/`execution_snapshot`/
`test_protocol_snapshot` are exactly the columns already written at job-creation time
(§4) — dispatch doesn't re-resolve anything, it just flips `job.status → 'dispatched'`
and returns what's already there. This is deliberate: architecture §5's "resolved once"
rule means dispatch is a status transition plus a read, never a second resolution.

## 7. Execution, photos, test results (F08/F09, and F11/F13-F14 scoping)

`POST /jobs/:id/execution-steps/:step/complete` and `POST /jobs/:id/photos` are
straightforward once `execution_snapshot` exists (§4). Photos need object storage;
Phase 1's own pattern for "no real infra available in this sandbox" (PGlite standing in
for Postgres, `apps/api/README.md`) applies again here — define a small
`ObjectStore` interface (`put(key, buffer) -> url`, `get(key) -> buffer`) with a
local-filesystem implementation under `RUNTIME_DIR/objects` for dev/proof, swapped for
real S3/R2 (architecture §2) at deploy time by changing one file, same as `db.ts` already
does for the database itself. Don't route photo bytes through the JSON sync envelope
(§9) — binary upload is a separate multipart `POST`, keyed by a client-generated `id` for
idempotency, independent of the mutation queue; forcing image bytes through a JSON batch
mutation is exactly the kind of premature-generality API spec §9 already warns against
for a different reason (operational-transform merging) but the same instinct applies.

**Scoping decision — test protocols start in this phase, not Phase 3, for F13/F14
only.** `forms-and-procedures-spec.md` §5 puts all of F11–F14 in Phase 3. But by the time
Phase 2 starts, F13 (coax TT) and F14 (fibre) are no longer blocked: their
`test_protocol` template versions are already seeded, verified, and activatable
(`seed.sql`, `verify-seed.mjs`, both passing) — and the prototype's AAR screen, whose
interaction design is settled (`CLAUDE.md`), captures these test readings unconditionally
for every job, not behind a compliance-profile check. Building `job_test_result` capture
now — for exactly the two networks already verified — matches both the settled
interaction design and the already-satisfied activation gate, and avoids reopening the
AAR screen's design a second time in Phase 3. What stays in Phase 3, deliberately: F11
(PC) and F12 (coax coletiva/individual), because their numeric limits haven't been
sourced yet (`06-phase3-compliance.md` §2), and everything that consumes test results for
a *regulatory* purpose — REF assembly, termo, deadlines — which only exists for
`ited_ready`/`ited_full` tenants.

`POST /jobs/:id/test-results` — one row per `(job, location_label, test_code)` into
`job_test_result`, `outcome` computed server-side via the same range/min/max evaluator
the prototype already implements in JS (`evalTest`, `fieldready-prototype.jsx:129`) —
port that function into `packages/core` so client (for instant phone-side pass/fail
before sync) and server (source of truth) can't disagree, rather than reimplementing it
twice.

## 8. Close-out (F19)

`POST /jobs/:id/complete` stamps `completed_at` — this is also the moment
`compliance_deadline` rows would be created for `ited_ready`/`ited_full` tenants
(`06-phase3-compliance.md` owns that logic; the `basic`-tenant path here just sets the
timestamp and moves on). `POST /jobs/:id/closeout` writes `job_closeout` from the
technician's side (`first_time_fix`, voice note, signature) — `rework_cause` stays
office-only (`PATCH /jobs/:id/closeout/rework-cause`), enforced by simply not exposing
that field on the technician-facing route at all rather than a runtime role check that
could be gotten wrong (PRD §6).

## 9. Sync: from one trivial mutation to the real set

Extend `packages/core/src/sync.ts`'s `SyncMutation` from a single `z.literal` into a
discriminated union on `type`, adding: `execution_step.complete`, `test_result.record`,
`closeout.submit`, `van_audit.record`. Each gets its own Zod payload schema and its own
`if (m.type === ...)` branch in `apps/api/src/routes/sync.ts`, following the exact
`checklist_item.update` shape already there (look up existing `applied_mutation` row
first, apply, insert the result) — no change to the envelope, the idempotency mechanism,
or the replay semantics Phase 1 already proved; only the number of registered handlers
grows.

`GET /sync/bootstrap` currently returns empty arrays (a deliberate stub, `sync.ts:73`).
Phase 2 makes it real: for the authenticated technician's `assigned_to` jobs with
`status in ('dispatched', 'in_progress', 'testing')`, return each job's
`readiness_snapshot`/`execution_snapshot`/`test_protocol_snapshot` plus current
`job_checklist_item` status, the tenant's latest `van_audit`, and any `equipment` rows
referenced by the resolved test protocol with their calibration status — exactly the set
the phone needs to operate fully offline from a cold start, per architecture §4.

## 10. Exit criterion — `phase2-proof.mjs`

Same shape as `apps/api/test/phase1-proof.mjs`, extended, not replaced:

1. Create a client, quote, accept it, `create-job` — assert the resulting
   `job_checklist_item` rows match the resolved template's scope split (job/van/office
   counts), matching the prototype's JOB-2041 fixture shape as a regression check against
   the settled design.
2. Attempt dispatch before readiness is met → `409` with the exact blocking shape API
   spec §5 documents (missing checklist item **and** a missing/stale van audit).
3. Mark the mandatory `job`-scope items `ok` via `POST /sync/mutations`
   (`checklist_item.update`), record a fresh `van_audit`, confirm equipment calibration
   is current → dispatch succeeds, `200`, snapshots present in the response.
4. Complete execution steps, upload a photo, record F13 test results for three outlets
   (reusing `seed.sql`'s real Tabela 6.12 limits) via sync mutations, close out with
   `first_time_fix: true`.
5. Confirm `v_job_readiness` and `v_first_time_fix_rate` reflect the real job just closed
   — not seeded data — proving PRD §8's "computed from real job data" criterion.
6. Repeat Phase 1's SIGKILL-mid-sync scenario, but on `execution_step.complete` instead of
   the trivial mutation — confirms the sync infra generalizes to a real domain mutation,
   not just the one it was proven against.

Not in this phase's scope, confirmed by `CLAUDE.md`/architecture §8: the actual Next.js
office UI and Expo/PWA phone client. This document specs the API surface and business
logic those clients will call; `fieldready-prototype.jsx` remains the settled reference
for what they should look and behave like once built.
