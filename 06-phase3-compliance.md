# FieldReady — Phase 3 design: compliance

v1.0 · Read after `05-phase2-job-loop.md`. Scope per `CLAUDE.md`/`forms-and-procedures-spec.md`
§5: **F11–F14 test protocols (remainder) → F15 REF assembly → F16 termo tracking → F17
statutory deadlines → F18 rótulo**. Reachable only for `ited_ready`/`ited_full` tenants
(`403` otherwise, API spec §7) — `basic`-tenant behavior is untouched by this phase.

*Exit criterion:* a real `ited_full` job produces a reconciled REF+termo pair with correct
deadline dates against a real PT working-day calendar, over HTTP, plus F11/F12 seeded and
verified the same way F13/F14 already are — **or**, if the source reading described in §2
hasn't happened yet by the time this phase is otherwise ready, everything except F11/F12
ships and F11/F12 stay `draft`, exactly as the activation gate already enforces. This
phase does not get to route around that gate by inventing numbers.

---

## 1. What's already de-risked, and what genuinely isn't

Phase 1 did more compliance groundwork than its own name suggests: the activation gate
(`fn_activate_template_version_guard`) and two fully verified `test_protocol` versions
(F13 coax-TT, F14 fibre) already exist and pass `verify-seed.mjs`. Phase 2 (§7 of that
doc) already wired `job_test_result` capture for exactly those two. So this phase's actual
new work is narrower than the form count (F11–F18, eight items) suggests:

- **Genuinely new:** F15 (REF assembly), F16 (termo tracking), F17 (deadlines) — none of
  this exists in any form yet.
- **Extends a proven pattern, blocked on a research step, not an engineering one:** F11
  (PC) and F12 (coax coletiva/individual) — same `seed.sql` pattern as F13/F14, same
  activation gate, just two more template versions once the numbers are sourced (§2).
- **Trivial:** F18 (rótulo) — one boolean/document field on close-out, not worth its own
  section.

## 2. F11/F12 — resolved, but F11 isn't the table it looks like

`CLAUDE.md` said to extend `seed.sql`'s pattern for F11 (Tabela 6.1) and F12 (Tabela
6.4/6.7/6.9) "when those get built." Both are now sourced — but reading Tabela 6.1
directly (`ManualITED4edicao_2019.pdf.pdf`, pp.161–163, `ited-ref-mapping.md` §7A.3's
new addendum) turned up something the "extend the same pattern" framing didn't
anticipate: **Tabela 6.1 isn't a numeric-limits table at all.** Unlike Tabelas
6.7/6.9/6.12/6.13/6.17, which give ITED-specific pass/fail numbers, Tabela 6.1 lists
which EN 50173 Class E link parameters must be tested (Return Loss, Insertion Loss,
NEXT, PSNEXT, ACR-N/F, PSACR-N/F, propagation delay, delay skew, wire map, length) and
states plainly that pass/fail is **the cable certifier's own built-in verdict against
EN 50173 Class E** — an external cabling standard this manual doesn't restate numerically,
not an ITED-authored threshold. Forcing that into the existing `dir: range|min|max` shape
would mean inventing a number to sit behind the `verified_by` gate — exactly what that
gate exists to prevent.

**Schema change required, not just a seed row:** add a fourth `TestProtocolTest.dir`
value, `external_pass_fail`, meaning "no min/max stored; the technician/certifier's own
pass/fail verdict is recorded as-is." Concretely:

1. `packages/core/src/template.ts`: extend `TestProtocolTest`'s `dir` enum to
   `["range", "min", "max", "external_pass_fail"]`; update the `.refine` so
   `external_pass_fail` requires neither `min` nor `max`.
2. `packages/core/src/test-protocol-eval.ts`'s `evalTest`: add a branch for
   `dir === "external_pass_fail"` — the "measured value" for this kind of test *is*
   `"pass"` or `"fail"` (whatever the certifier displayed), so `evalTest` returns that
   value directly (normalized/validated to `pass`/`fail`/`pending`) rather than computing
   anything numeric.
3. Seed F11 in `seed.sql`: one `test_protocol` version, `network_type: "PC"`, one test
   entry per EN 50173 Class E parameter from Tabela 6.1 (mark length as
   `mandatory: false` — the manual's own footnote 4 calls it "meramente informativo,"
   informational only, not a pass/fail gate). `verified_source`: *"Manual ITED 4.ª ed.,
   Tabela 6.1/6.1.1, p.161–162 — evaluated against EN 50173 Classe E by the certifying
   instrument's own pass/fail; no ITED-specific numeric limit exists for this network
   type."* That's a true, checkable citation — the honest version of "verified," not a
   weaker one.
4. Seed F12 the same way F13/F14 already were: values are already in
   `forms-and-procedures-spec.md` §3.4 (13,8 dB / 10,8 dB atenuação/slope, 47–862 MHz,
   both coletiva and individual; individual adds 23,4 dB / 8,4 dB at 950–2150 MHz) —
   `network_type: "CC"` (not `SMATV`, which F13 already owns — confirmed against
   `seed.sql`'s actual enum usage, not assumed from the form name).
5. Re-run `verify-seed.mjs` — **generalize it while touching it**: today it spot-checks
   F13/F14 by name (`06-phase3-compliance.md`'s earlier draft flagged this as a risk to
   check). With four seeded protocols instead of two, make its assertions iterate every
   seeded `test_protocol` version generically (found active + `verified_by` set +
   cross-tenant visible) rather than adding a third and fourth hardcoded block.

## 2a. `job-creation.ts`'s resolution key already matches this

Phase 2's adversarial review caught and fixed a bug where test-protocol resolution used a
job-type-slug code instead of `network_type` (`05-phase2-job-loop.md`'s implementation —
see the Phase 2 commit). That fix means F11/F12, once seeded, are automatically reachable
by any job whose inferred `network_type` is `PC`/`CC` — no additional resolution-logic
change needed in this phase, only the seed rows and the `dir` extension above.

## 3. `job_test_result` — extending beyond F13/F14

Phase 2 built capture for `network_type in ('SMATV', 'FO')` (coax-TT, fibre — F13/F14,
confirmed against `seed.sql`'s own template bodies, not assumed from the form names).
Adding F11 (`network_type = 'PC'`) and F12 (`network_type = 'CC'` for the
coletiva/individual coax cases, per schema's existing enum) needs no new columns —
`job_test_result` already carries `network_type`/`test_code`/`limit_ref` generically. The
only new logic is which protocol resolves for a given job's classification, which is the
same template-resolution function Phase 2 built for checklists
(`05-phase2-job-loop.md` §4), applied to `test_protocol`-kind templates instead —
reuse, not reimplementation.

## 4. F15 — REF assembly

`POST /jobs/:id/ref` creates the `ref_document` row; `ficha_fields` shape is already
fully specified (schema §10 comment, sourced from the real ANEXO,
`ited-ref-mapping.md` §7A.2) — the route's job is populating it from what the job already
knows (installer from `app_user.professional_registration_number`, building from
`job.address`/`client`, `cabos_instalados`/`outros_materiais` from
`job_checklist_item`/`quote_line` where they map to REF material categories) and leaving
the rest (`documentacao_facultativa`, `outras_identificacoes_relevantes`) as
office-editable free text via `PATCH /jobs/:id/ref`.

`POST /jobs/:id/ref/generate-pdf` — architecture §2 already specifies Playwright
print-to-PDF over an HTML template as the mechanism. Concretely: an HTML template file
(e.g. `apps/api/src/templates/ref.html`) rendered with the `ficha_fields` data, then
Playwright's `page.pdf()` against a headless render of that HTML, written to object
storage (the same `ObjectStore` interface Phase 2 introduces for photos,
`05-phase2-job-loop.md` §7) and the key saved to `ref_document.generated_pdf`. This needs
`playwright` as a new `apps/api` dependency — note it in `apps/api/README.md`'s
stack-substitution table if headless Chromium can't launch in whatever sandbox this gets
built in, the same honest way PGlite's substitution for Postgres is already documented.

Reconciliation is already enforced at the DB layer
(`fn_ref_termo_reconciliation`, schema §10) — the route just needs to surface its
exception as the clean `422` API spec §7 documents, same pattern
`templates.ts`'s activation route already uses for the test-protocol gate (catch, regex
on the message, translate to a structured error — don't add a second, redundant
application-layer check that could drift from the trigger's actual condition).

## 5. F16 — termo tracking

`POST /jobs/:id/termo` — the reconciliation check above fires here (inserting/updating
`termo_responsabilidade.ref_id_field` against an existing `ref_document.ref_id`).
`PATCH /jobs/:id/termo/recipients/:role` updates one entry in the `recipients` jsonb
array (five required parties, per spec F16) — read-modify-write is fine at this volume,
no need for a normalized child table. `POST /jobs/:id/termo/paper-copy-photo` reuses the
same photo-upload path as F09.

## 6. F17 — statutory deadlines and the PT working-day calendar

Two clocks (schema `compliance_deadline` comment, already correct): termo within 10
working days of `job.completed_at`; REF within 10 working days of
`termo_responsabilidade.issued_at`. `03-schema.sql`'s own comment is explicit that this
arithmetic belongs in application code, not SQL, "since holiday lists change yearly" —
concretely:

- **Library: `date-holidays` (npm), `new Holidays('PT')`.** It's maintained, covers
  Portugal's national holidays including the moveable ones (Carnaval, Corpo de Deus), and
  supports subdivision codes for Portugal's municipal holidays
  (`new Holidays('PT', '<municipality-code>')`) — which matters, because
  `CLAUDE.md` explicitly flags municipal variation as a real thing to get right, not a
  hand-rolled list that quietly misses a município's local holiday.
- **Gap this surfaces: `tenant` has no municipality field.** Add
  `tenant.municipality text` (nullable, defaults to no sub-region holidays applied) —
  a genuinely small additive migration, not a rethink of anything in §12's RLS setup.
  Without it, `compliance_deadline.due_on` can only account for national holidays, which
  is close but not correct for a tenant based somewhere with a local municipal holiday
  the statute's working-day count should skip.
- Compute `due_on` at the moment the triggering event happens (`job.completed_at` set, or
  `termo_responsabilidade.issued_at` set) — a small `addWorkingDays(date, 10, holidays)`
  helper in `packages/core` (pure function, easy to unit test against a known calendar
  year without a DB at all).
- Escalation (reminder at 5 days, warning at 8, alert at 10) is a scheduled job — this is
  exactly the workload architecture §2 names `graphile-worker` for ("low-volume,
  don't need sub-second latency"). A `GET /compliance/deadlines?status=open&due_before=`
  poll from that worker, transitioning `open → reminder_sent → warning_sent → overdue`,
  is enough; no new infrastructure beyond what architecture already specifies.

## 7. F18 — rótulo

One field, `job_closeout` or a new nullable `ref_document.rotulo_affixed boolean` —
whichever ends up housing it, this doesn't need its own endpoint or template kind; a
checkbox on the existing close-out or REF flow is sufficient per spec.

## 8. Exit criterion — `phase3-proof.mjs`

1. Seed F12 (values already available, §2) and F11 **if and only if** its real Tabela 6.1
   values have been sourced by the time this runs — assert the activation gate still
   rejects an unverified attempt either way, so the proof also re-confirms the gate
   hasn't regressed.
2. Create an `ited_full` tenant, run a job through Phase 2's full loop, classify it
   `existing_alteration` (the safe default, PRD §7), complete it.
3. `POST /jobs/:id/ref`, populate `ficha_fields`, generate the PDF, confirm a real file
   lands in the object store.
4. `POST /jobs/:id/termo` with a **mismatched** `ref_id_field` → `422`, same shape as the
   activation gate's error convention; then with the correct one → `200`, and confirm
   `compliance_deadline` rows exist with `due_on` computed correctly against a real PT
   holiday (pick a completion date where a naive calendar and a holiday-aware one would
   disagree — e.g. a job completed such that the 10th working day would otherwise land on
   a known national holiday — and assert the deadline skips it).
5. Confirm a `basic`-tenant job gets `403` on every `/jobs/:id/ref`, `/termo`,
   `/compliance/deadlines` route — the profile gate actually gates, not just greys out a
   button client-side that a direct API call could still hit.

Explicitly out of scope, restated from PRD §4: no ANACOM submission automation (the termo
number is entered by a human after issuance in ANACOM's reserved area, and stays the one
manual bridge — architecture §6), no certified billing engine.
