# FieldReady — project brief

Entry point for whoever (human or agent) starts implementation. Read this first; it
points at everything else and says what order to build in.

## What this is

Field-readiness, after-action-report, and ITED-compliance webapp (mobile later) for
telecom installers in Portugal. Full context and rationale: `01-PRD.md`. Domain research
this is built on: `ited-ref-mapping.md`, `forms-and-procedures-spec.md`. A working,
click-through UI prototype with mock data already exists at `fieldready-prototype.jsx` —
treat its interaction design (the phone flow especially) as settled, not up for
re-litigation; it survived two rounds of design review already.

## Reading order

1. `01-PRD.md` — problem, users, scope, the job-classification decision, non-goals
2. `02-ARCHITECTURE.md` — stack, multitenancy, offline sync strategy, template engine
3. `03-schema.sql` — the actual DDL, verified (run `verify-schema.mjs` yourself — see below)
4. `04-API-SPEC.md` — endpoint contracts, especially the two compliance gates and sync
5. `forms-and-procedures-spec.md` — the full 21-form inventory, compliance profiles
6. `ited-ref-mapping.md` — the regulatory research underneath the compliance forms
7. `seed.sql` — worked example of the compliance gate satisfied with real data (F13/F14
   test protocols, verified against Manual ITED 4.ª ed.)
8. `apps/api/README.md` — Phase 1's actual implementation: how to run it, how to prove
   the exit criterion, what's substituted from the architecture doc and why

## Before you write application code

```bash
npm install @electric-sql/pglite
node verify-schema.mjs 03-schema.sql
node verify-seed.mjs 03-schema.sql seed.sql
```

`verify-schema.mjs` — eleven checks: schema applies clean, RLS actually isolates two
tenants from each other, RLS fails safe with no tenant context set, system templates are
visible cross-tenant, the unverified-test-protocol gate blocks activation and a verified
one succeeds, the REF/termo reconciliation trigger blocks a mismatch and accepts a match,
all three dashboard views compute, and every non-`tenant` table has RLS enabled. If you
change the schema, re-run this before doing anything else — it caught two real bugs
(missing `tenant_id` on two line-item tables) during the first pass, which is exactly the
kind of mistake that's silent and expensive in a multi-tenant system.

`verify-seed.mjs` — seven more checks on top: `seed.sql`'s two real, verified
`test_protocol` template versions (F13 coax, F14 fibre — real Manual ITED limits, see
below) apply cleanly, are genuinely `active` with `verified_by` set (not a bypass), and
stay visible cross-tenant like any other system template. Re-run this too after any
schema or seed change.

## Non-negotiables — carried from prior design decisions, not up for re-derivation

- **Build the full form set for every compliance tier; gate by tenant `compliance_profile`,
  not by cutting product scope.** TDT.pt doesn't file paperwork today — that's a rollout
  fact about one tenant, not a spec for the product. See PRD §2, and project memory
  `fieldready-scope-feedback.md`.
- **Never add a "confirm all" shortcut to any checklist.** Destroys the readiness data
  the dashboard depends on. PRD §6.
- **Published `template_version` rows are immutable.** Amend by publishing a new version.
  If you find yourself writing `UPDATE template_version SET body = ... WHERE status =
  'active'`, stop — that's the one operation this schema is specifically built to prevent,
  because it would silently rewrite historical first-time-fix numbers.
- **The technician never classifies anything.** Root cause, ITED-scope edge cases — his
  job is to report what happened in his own words (voice-first); a human in the office
  assigns taxonomy afterward.
- **Photo-OCR leads, manual is the fallback, for every capture in the fleet today.** The
  meters can't export (confirmed 18 Aug). Don't build toward `instrument_export` as a
  near-term priority — it's schema-ready for a future meter purchase, nothing more.

## Provisional items — none remain open

Both blockers that used to gate this section are resolved as of 18 August, from real
source documents Rex retrieved directly (ANACOM's own domain never served either to
automated fetch):

- **`ref_document.ficha_fields`** — the real ANEXO from the official Procedimento Edição
  2024 PDF. Schema documents its exact shape. `ited-ref-mapping.md` §7A.2.
- **ITED numeric test limits** (Tabelas 6.7, 6.9, 6.12, 6.13, 6.17 of Manual ITED 4.ª
  ed.) — read directly from `ManualITED4edicao_2019.pdf`, pages 165–176. Real values are
  in `forms-and-procedures-spec.md` §3.4 and `ited-ref-mapping.md` §7A.3, and seeded as
  two verified, activated `test_protocol` template versions in `seed.sql` (F13 coax
  TT-level, Tabela 6.12; F14 fibre, Tabela 6.17) — run `node verify-seed.mjs` alongside
  `verify-schema.mjs` to confirm both pass the activation gate with real data, not a
  bypass.

The `fn_activate_template_version_guard` trigger and its `verified_by`/`verified_source`
requirement stay in the schema permanently either way — it's an editorial control against
someone editing limits without review, not a placeholder for missing research. Don't work
around it; extend `seed.sql`'s pattern for F11 (Tabela 6.1) and F12 (Tabela 6.4/6.7/6.9)
when those get built.

This is what "amendable later" looks like in practice for both items: the swap was a doc,
a schema comment, and a seed row — not a migration.

## Job classification — implement the three-way split, not a boolean

PRD §7 and `ited-ref-mapping.md` §7A.1: `job.ited_classification` defaults to
`existing_alteration` (the safe, over-inclusive default per the DL 123/2009 fine
schedule), and setting it to `out_of_scope` or `exempt` requires
`ited_classification_note` (enforced by a CHECK constraint already) and should route to
office review in the UI — never let the technician's phone app make this call.

## Build order

Each phase has an explicit exit criterion. Don't start the next phase's UI work until
the current one's criterion is actually true, not "basically working."

### Phase 1 — foundations — exit criterion met, 18 August

Built: `apps/api` (Fastify), `packages/core` (shared Zod schemas), schema/RLS wired
through real requests (`SET LOCAL app.current_tenant_id`, `src/db.ts`'s `withTenant`),
both auth flows, template engine CRUD including the activation gate over HTTP, and the
offline sync endpoint. See `apps/api/README.md` for how to run it and what's
substituted from the architecture doc's stack (npm workspaces not pnpm, no Turborepo
yet, PGlite not a standalone Postgres server — all noted there with why, none of it
changes the SQL/RLS/trigger logic itself).

**Exit criterion proven, not assumed:** `npm run proof:phase1` (root) spins up the real
API as a child process and, over HTTP only: confirms tenant B cannot see tenant A's
private template while both see shared system templates; confirms the test_protocol
activation gate rejects unverified/accepts verified over HTTP; submits a trivial
`checklist_item.update` sync mutation, **SIGKILLs the running server**, restarts it
against the same on-disk data, and replays the identical mutation batch, confirming
idempotent replay (`already_applied`, no double-effect) and that the restarted server
still accepts genuinely new mutations. 21/21 checks passing — `apps/api/test/phase1-proof.mjs`.

Not done in this pass, deliberately (architecture §8 — no job domain logic yet):
quotes/BOM, dispatch gate, execution steps, photos, close-out, compliance
(REF/termo/deadlines), dashboard, the actual web (Next.js) or mobile (Expo) clients.
Those are Phase 2/3/4, below.

### Phase 2 — the job loop
Quote → BOM → job creation with resolved checklist snapshot → readiness gate → dispatch
→ execution steps → photos → close-out. This is the loop every tenant uses regardless of
compliance profile — build and ship it before any compliance-tier work.

*Exit criterion:* a technician completes the full loop on the phone UI, offline, zero
typed text (PRD §8) — matching the phone flow already validated in the prototype.

### Phase 3 — compliance
Test protocols (blocked on the verification gate above), REF assembly, termo tracking,
statutory deadlines with a real Portuguese working-day holiday calendar (not a
hand-rolled one — use a maintained library/API and confirm which regional holidays
apply, since some are municipal).

### Phase 4 — cost intelligence
Site survey (F01), receipt OCR (buy a vendor, test on ~20 real receipts before
committing — architecture §6), supplier price comparison, the dashboard. Deliberately
last: needs 30+ real closed jobs before any of its numbers mean anything.

## What to run in parallel with Phase 1, not after it

Paper versions of the readiness card and close-out sheet, on real jobs, starting now.
Software can't validate whether the field workflow survives contact with an actual roof
in Lisbon — only a technician with a clipboard can, and that result should be feeding
back into Phase 2's design before Phase 2 is very far along.
