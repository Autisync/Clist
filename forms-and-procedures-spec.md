# FieldReady — forms, procedures and the amendment architecture

Spec, 17 August 2026. Supersedes the reduced-scope suggestion in the previous session.

Companion documents: `ited-ref-mapping.md` (regulatory research), `fieldready-prototype.jsx`
(working prototype).

---

## 0. The governing principle

Build for the most demanding tenant. Let each tenant switch modules on.

TDT.pt files nothing today and will have to change that. Other tenants already carry the
full ITED obligation. Neither should shape the product's ceiling — the first would make it
useless to the second, and the second would make it unusable for the first on day one.
The reconciliation is a **compliance profile per tenant**, not a smaller product.

Second principle, which everything below depends on: **every form is versioned data, never
code.** A published version is immutable. Amending a form means publishing a new version;
jobs keep a snapshot of the version they ran under. Skipping this is cheap today and a
rewrite in a year.

---

## 1. Two template layers

This is the part that makes multi-tenancy worth more than data isolation.

**System templates** are shipped and maintained by FieldReady: the ITED test protocols,
the REF assembly definition, the termo tracking rules, the statutory deadline maths. When
ANACOM publishes a new edition, we update the system template once and every tenant
inherits it.

**Tenant templates** are the tenant's own: their readiness lists, their execution steps,
their van layout, their quote-to-BOM rules.

A tenant may **fork** a system template. Forked templates stop auto-inheriting, and the
tenant gets a diff notification when the upstream system version changes, with a one-click
rebase where the change doesn't conflict. Without the fork/diff mechanic, tenants who
customise anything silently fall out of compliance the first time the regulation moves —
which is exactly the failure the product exists to prevent.

```
template
    id, kind, code, title
    layer         enum(system, tenant)
    tenant_id     null for system templates
    forked_from   template_id, null unless forked

template_version
    template_id, version int, status enum(draft, active, retired)
    effective_from, published_at, published_by
    body jsonb              -- items / tests / assembly rules
    -- immutable once status = active

job.template_snapshot  jsonb   -- resolved at dispatch, never re-read from template
```

`kind` is one of: `checklist`, `test_protocol`, `document_pack`, `report_assembly`,
`execution_steps`, `deadline_rule`.

---

## 2. Compliance profiles

A tenant's profile decides which modules are active and which are merely visible.

| Profile | Who | Active modules |
|---|---|---|
| `basic` | TDT.pt today | Readiness, van audit, safety, execution, photo evidence, deviation log, close-out, suppliers, dashboard |
| `ited_ready` | TDT.pt in transition | + equipment calibration register, test protocols, REF draft (not submitted) |
| `ited_full` | Certified ITED installers | + REF assembly and submission, termo tracking, statutory deadlines, rótulo |

Everything is built. `basic` tenants see the ITED modules greyed with a one-line
explanation and a switch. Moving a tenant up a profile is a settings change, not a
migration — which is what makes "TDT will have to start being compliant" a Tuesday
afternoon rather than a project.

Profile also drives the phone: an `ited_full` job puts *Importar do medidor* above
*Fotografar o medidor*, because instrument-generated output is what the regulation
prefers. A `basic` job keeps the photo path first.

---

## 3. Full form and procedure inventory

21 forms across five stages. Every one is a versioned template.

### 3.1 Pre-quote

**F01 · Site survey (levantamento)** — `checklist`
Trigger: before quoting anything above a threshold the tenant sets.
Owner: technician or owner. Gate: none.
Fields: access constraints, roof/mast condition, existing cabling type and condition,
distance runs, ATE/ATI location and state, power availability, obstructions and line of
sight, parking and access to height, photos, estimated hours, estimated BOM.
*Why it exists:* "erro de orçamento" is the second-largest rework cause in the prototype
data. This is the form that attacks it.

**F02 · Quote → BOM** — `checklist`
Trigger: quote accepted. Owner: office. Gate: blocks F03 until produced.
Fields: line items mapped to catalogue SKUs, quantities, planned hours by task, planned
supplier per line, margin target.
*Why:* the readiness list should be generated from the BOM, not typed twice.

### 3.2 Pre-job

**F03 · Readiness card** — `checklist`
Trigger: job scheduled. Owner: technician (phone). Gate: **blocks dispatch**.
Scope-split each item into `job` / `van` / `office` — 4 to 6 `job` items is the target.
Fields per item: category, label, quantity, mandatory flag, sourcing fallback.
Derived: readiness score, blocking items, pickup route.

**F04 · Van audit** — `checklist`
Trigger: weekly, configurable. Owner: technician, at the warehouse. Gate: stale audit
(> interval + grace) raises a warning on every readiness card that depends on van stock.
Fields: per-item present/quantity/condition, consumable levels, issues with notes.

**F05 · Equipment and calibration register** — `document_pack`
Trigger: continuous. Owner: office. Gate: **expired calibration blocks dispatch** on any
job whose test protocol requires that instrument.
Fields: instrument kind, make, model, serial, calibration certificate file, issue date,
expiry date, calibrating body.
*Why:* REF item (c) requires these certificates. An out-of-calibration meter produces an
indefensible REF, so the gate is a legal one, not a housekeeping one.

**F06 · Documentation pack** — `document_pack`
Trigger: job scheduled. Owner: office, auto-verified. Gate: blocks dispatch; never shown
on the phone.
Fields: signed quote, roof/condominium access authorisation, ata de condomínio where
applicable, AT insurance validity, executed project copy (also REF item (d)),
municipal opinions.

**F07 · Safety — trabalhos em altura** — `checklist`
Trigger: any job flagged working-at-height. Owner: technician, signed. Gate: blocks
dispatch. Appears on the phone as a `job`-scope item.
Fields: harness and lifeline inspection date, anchor point identified, ladder condition,
weather check, lone-working flag, signature.

### 3.3 In-job

**F08 · Execution steps** — `execution_steps`
Trigger: dispatch. Owner: technician. Gate: none — this is guidance, not a barrier.
Per job type, ordered, tickable, with the timer running.

**F09 · Photo evidence** — `document_pack`
Trigger: dispatch. Owner: technician. Gate: blocks close-out if mandatory shots missing.
Fields: before / during / after, plus job-type-specific required shots (mast fixing,
earthing, ATE interior, cable route, label placement).

**F10 · Deviation log** — `checklist`
Trigger: any time on site. Owner: technician, voice-first.
Fields: what changed versus the quote, extra materials consumed, extra hours, client-
requested variations, photo. Feeds both the close-out and the next quote.

### 3.4 Post-job — testing and compliance

**F11–F14 · Test protocols** — `test_protocol`, one per network family.
Trigger: installation complete. Owner: technician. Gate: blocks the conformity
declaration; failures must be resolved or explicitly waived by the client in writing.

| | Network | Manual ITED reference |
|---|---|---|
| F11 | Pares de cobre (PC) | Tabela 6.1, method 6.1.1 |
| F12 | Coaxial — rede coletiva e individual | Tabela 6.4, method 6.2.1, limits 6.7 (coletiva) / 6.9 (individual) |
| F13 | Coaxial — S/MATV, per-outlet (TT) | Tabela 6.5, method 6.2.2, limits **Tabela 6.12** |
| F14 | Fibra ótica | Tabela 6.14, method 6.3.1, limits 6.17 |

> **Structural correction, resolved 18 Aug (`ited-ref-mapping.md` §7A.3):** the
> prototype's original `TDT_TESTS` grid tested one point with five parameters (nível de
> sinal, MER, CBER, LBER, C/N). The real manual tests **two different points**, and F13
> covers only one of them:
>
> - **At the TT (tomada) — F13, per-outlet, what a technician measures on the phone
>   flow.** Tabela 6.12: nível de sinal and MER only, two parameters. Limits differ by
>   modulation: TDT via hertziana (Zona A, DVB-T, 64QAM) is 45–74 dBµV / MER ≥ 19,5 dB;
>   TDT via satélite (Zona B, DVB-S2, 8PSK) is 47–77 dBµV / MER ≥ 14 dB (recommended
>   midpoints 55 dBµV and 26 dB / 17 dB respectively).
> - **At the entrada da CR (head-end, upstream of the outlets) — Tabela 6.13, a separate
>   commissioning step, not part of the per-outlet AAR.** Four parameters: nível de
>   sinal, SNR, CBER, and (satellite only) PER, measured with 10 m of cable between
>   antenna and CR. Out of scope for F13's phone flow; `job_test_result.location_label`
>   and `network_type` already accommodate it if a future job type needs it.
>
> F12's coax attenuation/slope limits (Tabela 6.7 coletiva, 6.9 individual): 13,8 dB
> atenuação / 10,8 dB slope across 47–862 MHz for both; individual runs additionally
> carry a 950–2150 MHz limit of 23,4 dB / 8,4 dB slope (satellite IF band). Guaranteed
> connection class TCD-C-M.
>
> F14's fibre attenuation limits (Tabela 6.17): 1,8 dB at both 1310 nm and 1550 nm,
> minimum category OS1a.

Per measurement: location, test code, measured value, unit, limit reference, outcome,
**date performed**, **technician who performed it**, third-party entity if contracted,
instrument used, and capture source (`photo_ocr` / `manual`) with the raw photo retained
alongside the parsed value.

> **Capture source, confirmed 18 Aug:** the field meters in use cannot export readings.
> `instrument_export` is kept in the schema enum for forward compatibility — a future
> meter purchase may support it, and REF note 3 still prefers it where available — but it
> is inactive in the UI. Priority for every job, ITED or not, is **photo-OCR first,
> manual entry as fallback.** This reverts the ordering proposed in the previous session,
> which had assumed export capability that the actual fleet doesn't have.

> **Numeric limits — resolved 18 Aug, real values now in `seed.sql`.** The prototype's
> old thresholds were generic placeholders; real ones are above, sourced from Manual ITED
> 4.ª ed. pp. 165–172 (full citation and both source PDFs: `ited-ref-mapping.md` §7A.3).
> The `ited_full` compliance profile still **cannot be activated for any tenant** unless
> its `test_protocol` template version carries `verified_by` and `verified_source` — that
> gate stays permanently, as a control against anyone editing limits without review, not
> because the numbers are still unverified. Activating `ited_full` against a
> `draft`-status protocol remains a validation error the backend refuses. See schema
> `template_version.verified_by` and `seed.sql` for a worked example that satisfies it.

**F15 · REF assembly** — `report_assembly`
Trigger: all required test protocols complete. Owner: office. Gate: cannot generate while
any mandatory component is missing.
Assembles, per the Procedimento Edição 2024:

- (a) ficha de identificações — *field list still unknown, see open questions*
- (b) test results with dates and technician identification
- (c) calibration certificates for every instrument referenced in (b)
- (d) copy of the executed project
- (e) additional documentation

Output: PDF bundle, plus a pre-filled submission email to `ref@anacom.pt` whose subject
begins with the termo number. Zip allowed; file-transfer links are not accepted.

Reconciliation rule: the `ID do REF` on the ficha de identificações **must equal** the REF
identification field inside the termo (F16). Store it once, render it into both, and refuse
to generate the bundle if the two ever diverge — a mismatch is the kind of error that is
invisible on screen and fatal on submission.

**F16 · Termo de responsabilidade tracking** — `document_pack`
Trigger: installation complete. Owner: office. Gate: drives the deadline clocks.
Fields: termo number, issue date, ANACOM reserved-area reference, the five recipients with
per-recipient sent status, and photo evidence of the **paper copy placed inside the ATE**
(ATI in single-dwelling buildings).
The termo itself is issued only in ANACOM's reserved area — we prepare and track, we do
not replace. The termo number is the one manual bridge; design so it is the only one.

**F17 · Statutory deadlines** — `deadline_rule`
Two clocks, both in Portuguese working days, so a holiday calendar is required:

1. Termo issued within **10 working days of installation completion**
2. REF submitted within **10 working days of termo issue**

Escalation: reminder at 5 days, warning at 8, alert to the owner at 10.

**F18 · Rótulo ITED** — optional, per DL 123/2009: *"Cumpre o ITED. Apto para banda larga."*

### 3.5 Post-job — commercial

**F19 · Close-out / AAR** — `report_assembly`
Trigger: tests complete. Owner: technician then office.
Technician side: voice note, first-time-fix yes/no, client signature.
Office side: actual hours, materials consumed versus BOM, **root-cause taxonomy assigned
by the office, not the technician**, follow-up actions with owner and due date.

**F20 · Receipt capture** — feeds supplier price history; OCR with confirm-before-apply.
**F21 · Purchase order / pickup run** — generated from readiness shortfalls.

---

## 4. Amendment workflow

The thing you asked to be possible later, made concrete:

1. Editor opens template → system creates **draft** v(n+1), copying v(n)
2. Draft is edited freely and previewed against a past job
3. Publishing sets `status = active`, stamps `effective_from`, retires v(n)
4. **v(n) is never mutated.** Jobs dispatched under it keep its snapshot and keep being
   judged against its thresholds
5. In-flight jobs continue on their snapshot; only jobs dispatched after `effective_from`
   pick up the new version
6. Tenants with a fork of an amended system template get a diff and a rebase offer

Rule with teeth: if thresholds are edited in place rather than versioned, every historical
first-time-fix number silently rewrites itself and the dashboard starts lying. Immutability
is not fastidiousness here, it is what keeps the analytics true.

---

## 5. Build order

Sequenced so nothing is thrown away, and the riskiest unknowns land early.

**Phase 1 — foundations**
Template registry with the two layers and immutable versioning. Tenancy with RLS.
Compliance profiles. Offline sync proven end to end in week one, because it is the thing
most likely to sink the project and the least likely to be fixable late.

**Phase 2 — the job loop**
F02 → F03 → F05 → F06 → F07 → dispatch gate → F08 → F09 → F10 → F19.
This is the loop that works for every tenant regardless of profile.

**Phase 3 — compliance**
F11–F14 test protocols with real Manual ITED limits, then F15, F16, F17, F18.
Blocked on reading the limit tables and obtaining one real REF.

**Phase 4 — cost intelligence**
F01 survey, F20 receipts, F21 pickup runs, supplier price history, the dashboard.
Last because it needs 30+ completed jobs before it says anything true.

**Running in parallel, not after:** paper versions of F03 and F19 on real jobs from next
week. Not as a substitute for building — as the thing that tells you whether the field
half of the design survives contact.

---

## 6. Open questions — resolution status as of 18 August

All five are closed out one way or another; none block starting implementation. Full
reasoning in `ited-ref-mapping.md` §7A.

1. ~~Ficha de identificações field list~~ **Resolved 18 August** — Rex retrieved the real
   procedure PDF and DOCX directly (automated fetch never worked on ANACOM's domain).
   `ref_document.ficha_fields` in `03-schema.sql` now documents the actual ANEXO shape:
   installer (incl. professional registration number — added to `app_user`), building,
   cabos instalados table, outros materiais table, documentação obrigatória/facultativa,
   plus the free-text second page. Full field list in `ited-ref-mapping.md` §7A.2.
2. ~~Numeric test limits~~ **Resolved 18 August** — Rex retrieved both Manual ITED 4 PDFs
   directly; real Tabelas 6.7/6.9/6.12/6.13/6.17 now documented in §3.4 above and in
   `ited-ref-mapping.md` §7A.3, applied to `seed.sql`. The `verified_by` activation gate
   on `test_protocol` stays permanently as an editorial control, not because the values
   are still unverified.
3. **Which of TDT.pt's jobs are ITED-scope** — **resolved via DL 123/2009 primary text**
   (Artigos 60.º, 71.º–73.º, 83.º). Not new-build-vs-repair as assumed; the real
   distinction is licensed work (Art. 71) vs. unlicensed (Art. 72) vs. alteration of an
   existing building's shared infrastructure (Art. 83, still a real simplified-project
   obligation, enforced as a "muito grave" offence under Art. 89.º §3(x)). A narrow
   like-for-like antenna-head swap touching no shared cabling is a genuine edge case the
   statute doesn't resolve; default it into scope and route it to office review rather
   than deciding it in the app. Job classification logic in the architecture doc reflects
   this three-way split, not a single flag.
4. **Meter export capability** — **confirmed: the fleet's meters cannot export.**
   `instrument_export` is inactive; photo-OCR leads, manual is the fallback. See §3.4
   revision above.
5. **A real completed REF + termo** — still genuinely open; no substitute for asking
   someone who holds one. Non-blocking — the schema absorbs whatever the real document
   turns out to contain via a template version bump, not a migration.
