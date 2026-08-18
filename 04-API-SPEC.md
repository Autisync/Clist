# FieldReady — API surface

v1.0 · 18 August 2026 · Read after `02-ARCHITECTURE.md` and `03-schema.sql`. REST over
HTTPS, JSON bodies, all request/response shapes validated with the same Zod schemas the
DB layer uses (`packages/core`) so client and server can never silently disagree.

Full CRUD listings are kept terse — they're standard. Detail is spent on the endpoints
that carry real logic: the two compliance gates, dispatch, and sync, since those are
where a coding agent needs the actual contract, not just a route name.

---

## 1. Auth

Every authenticated request carries a session token; the server resolves it to a
`(tenant_id, user_id)` pair and issues `SET LOCAL app.current_tenant_id` before any query
— see architecture §3. There is no endpoint that accepts a tenant_id from the client.

| Method & path | Purpose |
|---|---|
| `POST /auth/office/login` | Email/password or magic-link exchange → session cookie |
| `POST /auth/office/logout` | |
| `POST /auth/technician/pair` | Office-issued invite token → registers a `technician_device`, sets initial PIN |
| `POST /auth/technician/login` | `{device_id, pin}` → device-bound session, long-lived (field use, not re-login per job) |
| `POST /auth/technician/revoke/:device_id` | Office action; sets `revoked_at` |

## 2. Templates

```
GET    /templates?kind=&layer=              list, tenant's own + visible system templates
POST   /templates                            create a tenant template (optionally {forked_from})
GET    /templates/:id/versions
POST   /templates/:id/versions                create a new draft version
POST   /templates/:id/versions/:version/activate
```

**`POST /templates/:id/versions/:version/activate`** — the compliance gate
(`ited-ref-mapping.md` §7A.3, schema `fn_activate_template_version_guard`). Sets
`status='active'`, `effective_from=now()`, retires the previous active version.

```jsonc
// request — kind != 'test_protocol'
{}

// request — kind == 'test_protocol'
{ "verified_by": "<user_id>", "verified_source": "Manual ITED 4ª ed., p.168, Tabela 6.12" }

// 422 if a test_protocol is activated without verification — the DB trigger is the
// real enforcement; this endpoint just surfaces it as a clean error rather than a
// raw constraint violation:
{ "error": "unverified_test_protocol",
  "message": "Cannot activate: numeric limits not yet confirmed against Manual ITED. See ited-ref-mapping.md §7A.3." }
```

Forking: `POST /templates {forked_from: "<system_template_id>", ...}` copies the source's
active version `body` into a new tenant-owned draft. A background job periodically diffs
forked templates against their upstream's current active version and flags drift for
office review (architecture §5) — not a v1-blocking endpoint, note it for Phase 3.

## 3. Catalog, suppliers, prices, receipts

```
GET/POST         /catalog-items
GET/POST/PATCH    /suppliers
POST              /suppliers/:id/refresh-places      pulls hours/address from Google Places, bumps synced_at
GET               /suppliers/:id/prices
POST              /suppliers/:id/prices               manual price entry
POST              /receipts                            upload image → enqueues OCR
GET               /receipts/:id                         includes parsed receipt_line rows once OCR completes
POST              /receipts/:id/confirm                 {lines: [{line_id, item_id, price}]} → writes supplier_price rows, status='confirmed'
GET               /catalog-items/:id/sourcing            ranked supplier options: coverage → open-now → price (prototype's pickup-route logic, server-side)
```

`POST /receipts/:id/confirm` is the human-in-the-loop step architecture §6 requires —
OCR output is never written to `supplier_price` directly.

## 4. Clients, quotes

```
GET/POST/PATCH  /clients
GET/POST         /quotes
PATCH             /quotes/:id/lines
POST              /quotes/:id/accept     status → accepted, unlocks job creation
POST              /quotes/:id/create-job  materializes a `job` + job_checklist_item rows from the quote + resolved templates
```

## 5. Jobs — the core loop

```
GET     /jobs?status=&assigned_to=
GET     /jobs/:id
PATCH   /jobs/:id                       office edits: schedule, assignment, ited_classification
GET     /jobs/:id/readiness             computed from v_job_readiness + per-item detail
PATCH   /jobs/:id/checklist/:item_id    technician: {status: 'ok'|'missing'}
POST    /jobs/:id/dispatch              THE GATE — see below
POST    /jobs/:id/execution-steps/:step/complete
POST    /jobs/:id/photos                multipart upload, {phase, required_tag?}
POST    /jobs/:id/test-results          {network_type, location_label, test_code, measured_value, capture_source, raw_capture_file?}
POST    /jobs/:id/complete              sets completed_at → starts the termo 10-working-day clock (compliance_deadline row created)
POST    /jobs/:id/closeout              {first_time_fix, technician_note_transcript, technician_voice_note_file, client_signature_file}
PATCH   /jobs/:id/closeout/rework-cause  office-only: {rework_cause} — never technician-writable (PRD §6)
```

**`POST /jobs/:id/dispatch`** — refuses with `409` unless *all* of:

1. Every mandatory `job_checklist_item` where `scope='job'` has `status='ok'`.
2. Every `job_checklist_item` where `scope='van'` is covered by a `van_audit` whose
   `next_due_at` hasn't passed (stale audit blocks dispatch, per spec F04).
3. Every instrument referenced by the job's resolved test protocol has
   `equipment.calibration_expires_on >= current_date` (spec F05 — the calibration gate).
4. If `tenant.compliance_profile != 'basic'`: `job.ited_classification` is set (not left
   at the implicit default without office review) — see PRD §7.

```jsonc
// 409 response shape, one entry per failing check — the phone UI renders this
// directly as the "faltam N" screen, not a generic error string:
{
  "error": "not_ready",
  "blocking": [
    { "kind": "checklist_item", "item_id": "...", "label": "Fonte alimentação 24V" },
    { "kind": "calibration_expired", "equipment_id": "...", "kind_label": "Medidor de campo DVB-T2", "expired_on": "2026-07-30" }
  ]
}
```

On success: `job.status → 'dispatched'`, response includes `readiness_snapshot`,
`execution_snapshot`, `test_protocol_snapshot` as resolved and frozen at this moment
(architecture §5) — the client persists these locally and never re-fetches template
data mid-job.

## 6. Equipment & calibration

```
GET/POST/PATCH  /equipment
POST             /equipment/:id/calibration    {cert_file, issued_on, expires_on}
GET              /equipment/expiring?within_days=14      office worklist
```

## 7. Compliance — REF, termo, deadlines

Only reachable for `ited_ready`/`ited_full` tenants; `403` otherwise.

```
POST   /jobs/:id/ref                    creates ref_document, ficha_fields from the (provisional) template
PATCH  /jobs/:id/ref                    edit ficha_fields, attach documents
POST   /jobs/:id/ref/generate-pdf        assembles the PDF (Playwright render, architecture §2)
POST   /jobs/:id/termo                   {number, ref_id_field, issued_at, anacom_area_ref}
                                          — DB trigger enforces ref_id_field == ref_document.ref_id (schema §10)
PATCH  /jobs/:id/termo/recipients/:role  {sent_at}
POST   /jobs/:id/termo/paper-copy-photo  evidence upload
GET    /compliance/deadlines?status=open&due_before=
```

**`POST /jobs/:id/termo`** returns `422` with the same shape as the ref/termo
reconciliation trigger's message if `ref_id_field` doesn't match the job's existing
`ref_document.ref_id` — surfaced cleanly rather than as a raw SQL error, same pattern as
§2's activation gate.

## 8. Dashboard

Thin read layer over the SQL views — no business logic lives here, which is
deliberate: if a number needs to change, it changes in `03-schema.sql`, not in two
places.

```
GET /dashboard/first-time-fix-rate?months=6
GET /dashboard/hours-variance?by=job_type
GET /dashboard/readiness-correlation     -- readiness_pct bucketed against first_time_fix, the prototype's headline chart
GET /dashboard/price-alerts               -- supplier_price rows where price > prev_price * 1.03, joined to cheaper alternatives
GET /dashboard/recommended-actions        -- generated from the above, same logic as the prototype's static list, now computed
```

## 9. Sync (technician phone, offline-first)

The Phase-1 risk architecture §4 calls out. One endpoint, designed for the
custom-queue approach (Option B):

```
POST /sync/mutations
```

```jsonc
// request — a batch of locally-queued mutations, each client-UUID-keyed for
// idempotent replay (retrying a batch that partially succeeded must not double-apply)
{
  "mutations": [
    {
      "client_mutation_id": "b3f1...-uuid-generated-on-device",
      "type": "checklist_item.update",
      "job_id": "...",
      "payload": { "item_id": "...", "status": "ok" },
      "occurred_at": "2026-08-18T09:14:02Z"   // device clock, for ordering only — never trusted for business logic
    }
  ]
}

// response — per-mutation result, so a partial batch failure is legible
{
  "results": [
    { "client_mutation_id": "b3f1...", "status": "applied" },
    { "client_mutation_id": "a91c...", "status": "already_applied" },
    { "client_mutation_id": "77de...", "status": "rejected", "reason": "job_already_dispatched" }
  ]
}
```

Server keeps a `client_mutation_id` uniqueness constraint per tenant so replay is safe
by construction. Conflict policy given the domain property architecture §4 relies on
(one technician owns one job at a time): last-write-wins per field is sufficient for v1;
do not build operational-transform-style merging — there's nothing in this domain that
needs it, and building it anyway is exactly the kind of premature complexity that would
delay proving the sync loop itself.

`GET /sync/bootstrap?since=<cursor>` — the download direction: everything the device
needs to operate offline (its assigned jobs' snapshots, active van_audit, equipment
calibration status) as of a cursor, for the initial pull and periodic refresh when signal
is available.
