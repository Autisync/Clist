# FieldReady — Architecture

v1.0 · 18 August 2026 · Read after `01-PRD.md`. Schema in `03-schema.sql`, endpoints in
`04-API-SPEC.md`, build sequencing in `CLAUDE.md`.

Every stack choice below is a recommendation with a one-line reason, not a constraint
handed down from nowhere — swap anything with an equally good reason.

---

## 1. Shape of the system

```
┌─────────────────┐     ┌─────────────────┐
│   Web app        │     │  Mobile (phase 2+)│
│   Next.js, office │     │  Expo/React Native │
│   + technician PWA│     │  same API          │
└────────┬─────────┘     └────────┬─────────┘
         │ HTTPS/JSON               │ HTTPS/JSON + offline sync
         └───────────┬─────────────┘
                      │
              ┌───────▼────────┐
              │   API service    │  Node.js, Fastify, TypeScript
              │   REST + Zod      │  Auth, RLS-aware DB client
              └───────┬────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
┌───────▼──────┐ ┌───▼────┐ ┌──────▼──────┐
│  PostgreSQL    │ │ Object  │ │ External     │
│  RLS per tenant│ │ storage │ │ Google Places │
│                │ │ (S3/R2) │ │ Moloni/InvXp  │
└───────────────┘ └────────┘ └──────────────┘
```

Monorepo, TypeScript everywhere, one set of types shared between web, mobile and API.

## 2. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | Standard, fast, shares types/validation across web/mobile/API without publishing packages |
| API | Fastify + TypeScript | Lighter than Nest for a team of one to a few; schema validation via Zod maps directly to OpenAPI |
| Validation | Zod, shared package `packages/core` | Same schemas validate API input, generate types, and run client-side on the phone before a sync attempt |
| Database | PostgreSQL 16+ | Native row-level security is the multitenancy mechanism (§3) — not optional given the isolation requirement |
| DB access | Drizzle ORM | Thin layer over SQL, first-class RLS/raw-SQL support, migrations as reviewable SQL — matters when the schema is this compliance-sensitive |
| Web app | Next.js (App Router) | Office dashboard and the technician PWA are the same codebase; App Router's route groups cleanly separate `/office/*` from `/field/*` |
| Styling | Tailwind + shadcn/ui | Matches the existing prototype (`fieldready-prototype.jsx`) — component patterns carry over directly |
| Mobile | Expo (React Native) | Phase 2+. Shares `packages/core` validation/business logic with the web PWA; Expo's OTA updates matter for a fleet of field devices |
| Offline sync | See §4 — this is the one genuinely open decision | |
| File storage | S3-compatible (Cloudflare R2 or AWS S3, eu-west) | Photos, calibration certs, generated REF PDFs. R2 has no egress fee, relevant once photo volume grows |
| PDF generation | Playwright print-to-PDF from an HTML template | REF assembly (F15) is structured, multi-section, needs real layout control — a headless-browser render is more maintainable than a low-level PDF-drawing library for this |
| Auth — office | Session cookie + email/password or magic link, tenant-scoped | Standard; no need for a heavier identity provider at this scale |
| Auth — technician | Device-bound session token + 4-digit PIN | Matches the phone UX already designed; PIN is a second factor on top of the device pairing, not the whole auth |
| Deployment | Docker containers on Fly.io or Render, Postgres on Fly Postgres/Neon (EU region) | Cheap at this stage, EU region matters for a Portuguese customer base even pre-GDPR-formalities |
| Background jobs | A Postgres-backed queue (e.g. `graphile-worker`) over adding Redis | One fewer moving part; the workloads (deadline reminders, Places refresh, receipt OCR calls) are low-volume and don't need sub-second latency |

## 3. Multitenancy

Every tenant-scoped table carries `tenant_id uuid not null`. Row-level security is
enabled on every one of them; the application connects as a low-privilege role that
**cannot** bypass RLS, and every request sets `app.current_tenant_id` via
`SET LOCAL` at the top of the transaction. This is not a defense-in-depth extra — it is
the actual isolation mechanism. Application-layer `WHERE tenant_id = ?` filtering is
present too, but RLS is what's relied on if that filter is ever forgotten in a new
endpoint.

Concretely, every table gets:

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

See `03-schema.sql` for the full, applied version — this is not left as an exercise.

**Compliance profiles** (`basic` / `ited_ready` / `ited_full`) live on the `tenant` row
and gate feature visibility at the application layer (§6, PRD §3). They are not a
tenancy mechanism, just a feature flag with a defined upgrade path.

## 4. Offline sync — the one open decision, resolved with a phased answer

The hardest engineering problem in this system is a technician inside a building with no
signal completing a full job cycle, then syncing cleanly when he's back in range. Two
credible approaches:

**Option A — a dedicated local-first sync engine** (PowerSync or ElectricSQL, both
Postgres-native). Handles conflict resolution, partial sync, and local SQLite
persistence for you. Real engineering leverage, but it's a new piece of infrastructure
to learn and operate, and both are young enough that hitting an edge case means reading
the source.

**Option B — a custom queue.** Local writes go into an IndexedDB (web PWA) or SQLite
(Expo) outbox with a client-generated UUID, a background sync loop POSTs queued
mutations in order, server applies them idempotently keyed on that UUID. More code,
fully understood code.

**Recommendation: start with B, revisit A once the job loop (Phase 2) is proven.**
The domain has a property that makes B tractable: one technician owns one job at a time,
so write conflicts between users are rare by construction — the hard part of A (merging
concurrent edits) mostly doesn't apply here. What does matter — durability, ordered
replay, idempotent apply — is buildable directly. If sync complexity grows once F11–F18
(compliance forms, larger payloads with photos) land, re-evaluate PowerSync then with a
real workload to test it against rather than a guess.

Either way, **this is the first thing to build and prove**, before any UI polish —
PRD §8 makes it a Phase-1 exit criterion, not a Phase-2 nice-to-have.

## 5. Template engine — how versioned forms actually run

Recap from `forms-and-procedures-spec.md` §1 and §4, stated here as an implementation
contract:

1. A `template_version` is immutable once `status = 'active'`. The only way to change a
   published form is to create a new `draft` version and publish it, which retires the
   old one (`status = 'retired'`, `effective_from` unaffected).
2. At dispatch, the API resolves whichever `template_version` is `active` for that
   template and writes its `body` into `job.template_snapshot` (jsonb, denormalized,
   never re-read from the template tables afterward). This is what makes historical
   first-time-fix numbers trustworthy even after thresholds change.
3. The phone client renders purely from `job.template_snapshot` — it never needs to
   resolve template inheritance, forking, or versioning logic on-device. All of that
   complexity resolves once, server-side, at dispatch time.
4. System templates (`layer = 'system'`) ship in a seed migration, versioned like
   everything else. A tenant fork (`forked_from`) is a normal tenant-owned template row
   that copies a system version's `body` as its starting draft.

## 6. Integrations

**Google Places (supplier location/hours).** Cache `place_id` indefinitely (Google's
terms exempt it); cache the remaining fields (address, hours, phone) with a `synced_at`
timestamp and refresh on a schedule (weekly is enough — see the dashboard's own
recommendation to that effect in the prototype) rather than treating the initial import
as permanent.

**Moloni / InvoiceXpress / Vendus (billing).** Integrate, don't rebuild. v1 needs only a
one-way push: job → line items → draft invoice in whichever the tenant uses. Model as a
pluggable `billing_provider` interface so a second provider is an adapter, not a rewrite.

**Receipt OCR.** Buy, don't build — Veryfi, Mindee or Google Document AI (PRD's non-goals
extend the same logic here: this is a solved problem elsewhere). Test against ~20 real
Rexel/Sonepar/Casa das Antenas receipts before committing to a vendor; Portuguese thermal
receipts are exactly the kind of input that separates OCR vendors' marketing claims from
their actual accuracy.

**ANACOM ITED-ITUR reserved area.** No API exists. The termo is issued there manually;
FieldReady prepares the data and stores the termo number the office pastes back in
(`termo_responsabilidade.number`) — see PRD §4 non-goals and schema `report_assembly`
reconciliation rule.

## 7. Security notes specific to this domain

- Calibration certificates and REF documents are the evidentiary basis for a legal
  filing — treat them as append-only. No hard delete on `equipment.calibration_cert`,
  `ref_document`, or `termo_responsabilidade` rows; supersede, never overwrite.
- The `ref_document.ref_id` ↔ `termo_responsabilidade` reconciliation (spec §3.4, F15) is
  enforced with a database constraint, not just application logic — see schema.
- PIN-based technician auth is a second factor bound to a specific device registration,
  not a standalone password — a stolen PIN without the paired device is useless. Device
  pairing itself happens through an office-issued invite, not self-registration.

## 8. What Phase 1 actually builds

Concrete enough to hand to an agent directly; see `CLAUDE.md` for the task breakdown.
Tenancy + RLS, the template engine (§5), auth (both flows), and a working offline sync
loop (§4, Option B) carrying nothing but a trivial "ping" mutation end-to-end. No job
domain logic yet — the goal is proving the hardest infrastructure risk in isolation
before building business logic on top of it.
