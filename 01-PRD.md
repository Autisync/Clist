# FieldReady — Product Requirements Document

v1.0 · 18 August 2026 · Companion docs: `ited-ref-mapping.md`, `forms-and-procedures-spec.md`,
`02-ARCHITECTURE.md`, `03-schema.sql`, `04-API-SPEC.md`, `CLAUDE.md`

---

## 1. Problem

Field telecom installers (antenna, TDT, SAT, MATV, fibre) run jobs with no structured
readiness check, no structured after-action record, and no supplier price memory. Three
consequences, evidenced in prototype-modelled data and confirmed by direct experience on
a TDT.pt job in Lisbon:

- Jobs get dispatched missing materials or tools, forcing return visits that erase margin
  and delay the client.
- Quotes don't improve over time because actual-vs-quoted hours and materials are never
  captured in a form anyone reuses.
- In Portugal, a meaningful share of this work is legally required to produce a
  Relatório de Ensaios e Funcionalidade (REF) and a termo de responsabilidade de
  execução under ANACOM's ITED regime (Decreto-Lei 123/2009, Procedimento de Avaliação
  Edição 2024) — and today that obligation is met, if at all, with loose paperwork and
  no deadline tracking, against fines that reach €1,000,000 for large offenders on the
  most serious breaches.

## 2. Users

**Technician (field).** Low-to-moderate technology comfort, works gloved, outdoors, often
without signal. Needs the phone to ask almost nothing of him: one decision per screen,
big targets, voice and photo over typing. He is the primary source of every fact the
system has — if the interface makes him rush past a check, that data point silently
becomes false and every downstream feature quietly degrades. See "Design constraint:
technician trust," §6.

**Office / owner.** Runs quotes, tracks jobs and money, is the primary user of the
dashboard and the one who resolves anything the technician flags rather than classifies
himself (root cause, ITED-scope edge cases).

**Compliance-obligated installer (a different tenant from TDT.pt).** Already produces
REFs and termos, wants the deadline clock and the assembly automated. This user's needs
define the ceiling of what the product builds; TDT.pt's current lack of paperwork is a
starting maturity level, not a scope constraint — see [[fieldready-scope-feedback]] in
project memory.

## 3. Scope — what ships

The full 21-form inventory in `forms-and-procedures-spec.md` §3, all built, gated behind
per-tenant **compliance profiles** (`basic` / `ited_ready` / `ited_full`) rather than
behind product tiers. Nothing is left out because today's pilot tenant doesn't need it
yet.

Core loop, every tenant: quote → BOM → readiness gate → dispatch → execution → tests →
close-out / AAR → history.

Compliance loop, `ited_ready`/`ited_full` tenants: equipment calibration register → job
classification (§7 below) → ITED test protocols → REF assembly → termo tracking →
statutory deadlines.

Commercial loop, all tenants: supplier profiles synced from Google Places → price
history via receipt OCR or manual entry → cheapest-open-supplier sourcing on any
readiness shortfall → dashboard.

## 4. Non-goals

- **Invoicing / faturação.** Portugal requires AT-certified billing software. Integrate
  with Moloni, InvoiceXpress or Vendus; do not build a competing certified billing engine.
- **Replacing the ANACOM termo submission.** The termo de responsabilidade de execução is
  issued exclusively in ANACOM's reserved ITED-ITUR area. FieldReady prepares the data
  and tracks the deadline; it does not submit on the installer's behalf.
- **General project management / CRM.** No Gantt charts, no marketing pipeline. A quote
  becomes a job; that's the whole commercial surface for v1.
- **Self-serve SaaS signup, billing, or public marketing site.** Multi-tenant *data*
  isolation ships from day one (see architecture doc); self-serve tenant onboarding does
  not. Tenants are provisioned manually until there's a second real customer.

## 5. North-star metric

**First-time-fix rate** — the share of jobs closed without a second visit. Every feature
either raises it or explains a failure that will. Rationale in `forms-and-procedures-spec.md`
§0: it is also what the product will be sold on.

Supporting metrics, all derivable from the schema without extra instrumentation: quoted-
vs-actual hours variance by job type, quoted-vs-actual materials variance, readiness score
at dispatch time correlated against rework, days-to-termo and days-to-REF against the
statutory 10-working-day clocks.

## 6. Design constraint: technician trust

Carried over from prior UX work on this project and restated because it governs every
form in the inventory, not just the phone checklist it was designed for:

- One decision per screen, ≥56px tap targets (gloves), pass/fail shown as icon + word +
  colour together (colour alone fails ~8% of men).
- Zero required typing where a photo or voice note can substitute; manual entry always
  available as a fallback, never as the default.
- The technician reports what happened in his own words; the office (or an LLM pass over
  that text) assigns taxonomy — root cause, ITED scope edge cases. Making him choose from
  a dropdown mid-job produces uniformly wrong data, because everyone picks the first
  option under time pressure.
- **Hard rule, no exceptions:** never add a "confirm all" / "looks fine" shortcut button
  to any checklist. It trades five seconds of technician time against the integrity of
  the readiness score, and the readiness score is what the entire dashboard and the
  fine-avoidance case both stand on.

## 7. Job classification — a decision, not a flag

Resolved via primary-source reading of DL 123/2009 (`ited-ref-mapping.md` §7A.1); this is
the one place the PRD needs to be explicit because it's easy to oversimplify into a
single boolean.

Every job is classified at quote time into one of:

1. **`licensed`** — the work sits inside a municipal licensing/prior-communication
   process (Artigo 71.º). Full formal ITED project regime.
2. **`existing_alteration`** — an existing building, and the work alters shared coax/
   cabling infrastructure: new run, new outlet, re-cabled S/MATV head-end (Artigo 83.º).
   Simplified project, still a real dual termo obligation, still enforced (Artigo 89.º
   §3(x), "muito grave").
3. **`out_of_scope`** — a narrow like-for-like antenna/LNB head swap touching no shared
   cabling. Genuinely ambiguous on the statute text. **Default every job into
   `existing_alteration` unless a human explicitly downgrades it** — the fine schedule
   makes over-inclusion the safe error.
4. **`exempt`** — Artigo 60.º's narrow building-nature exemption. Rare; requires a
   projetista's declaração de responsabilidade to invoke.

This classification decides which forms in the F11–F18 compliance tail apply to a given
job. It is a first-class field on `job`, not an inferred one — see schema.

## 8. Success criteria for v1 (Phase 1–2, see `CLAUDE.md`)

- A technician completes the readiness → execution → close-out loop on a real job using
  only the phone UI, offline, with zero typed text.
- A dispatch is blocked by the readiness gate at least once in the pilot and the missing
  item is sourced correctly (right supplier, correct open/closed state, correct price).
- Office view shows first-time-fix rate and quoted-vs-actual variance computed from real
  (not seeded) job data.
- Multi-tenant isolation verified: two tenants' data provably cannot cross, tested with
  RLS policy tests, not just application-layer filtering.

## 9. Explicitly deferred to Phase 3–4

ITED test protocols with verified numeric limits (blocked on human verification, not
engineering — see `ited-ref-mapping.md` §7A.3), REF/termo assembly and submission
prep, the cost-intelligence dashboard, receipt OCR. Sequencing and rationale in
`CLAUDE.md`.
