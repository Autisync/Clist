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

## 2. F11/F12 — the one real blocker, and how to not fake it

`CLAUDE.md` is explicit: *"extend `seed.sql`'s pattern for F11 (Tabela 6.1) and F12
(Tabela 6.4/6.7/6.9) when those get built."* As of this writing those tables haven't been
read from the source PDF the way Tabelas 6.12/6.17 were on 18 August
(`ited-ref-mapping.md` §7A.3) — F12's *attenuation/slope* limits are already quoted in
`forms-and-procedures-spec.md` §3.4 (13,8 dB / 10,8 dB across 47–862 MHz, plus the
950–2150 MHz satellite-IF figures), which is enough to seed F12 today. **F11's Tabela 6.1
values are not yet quoted anywhere in this repo's docs** — that is the actual remaining
gap, not an engineering task.

Do not seed F11 with placeholder or estimated numbers to make a proof script pass. The
`verified_by`/`verified_source` gate exists specifically to prevent exactly that
failure mode (schema comment, §4 of `03-schema.sql`) — a fabricated-but-plausible value
would satisfy the trigger's NOT NULL check while defeating its entire purpose. The correct
sequence, mirroring 18 August exactly:

1. Read Manual ITED 4.ª ed., Tabela 6.1 (method 6.1.1, pares de cobre), from the actual
   source PDF already in this repo (`ManualITED4edicao_2019.pdf.pdf`) or the alternate
   edition (`Manual-ITED4-vfinal-atec.pdf.pdf`).
2. Add the real values to `ited-ref-mapping.md` §7A.3 as a dated addendum, same format as
   the existing F13/F14 entry.
3. Add an F11 `test_protocol` template version to `seed.sql`, `verified_by`/
   `verified_source` set to a real reviewer and page citation, following F13/F14's rows
   line for line.
4. Re-run `verify-seed.mjs` — it should pick up F11 automatically since it iterates
   seeded `test_protocol` versions generically, not by hardcoded name (confirm this
   before relying on it; if the current script only spot-checks F13/F14 by name, extend
   its assertions to iterate all seeded `test_protocol` templates rather than adding a
   third hardcoded block).

F12 can be seeded now with the values already quoted in `forms-and-procedures-spec.md`
§3.4 — no additional source-reading step blocks it.

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
