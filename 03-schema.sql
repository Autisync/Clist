-- ============================================================================
-- FieldReady — database schema
-- v1.0 · 18 August 2026
--
-- Companion docs: 01-PRD.md, 02-ARCHITECTURE.md, forms-and-procedures-spec.md,
-- ited-ref-mapping.md. Read 02-ARCHITECTURE.md §3 and §5 before this file —
-- it explains *why* RLS and the template-versioning pattern look like this.
--
-- Conventions:
--   - uuid primary keys (gen_random_uuid()), timestamptz everywhere, jsonb for
--     flexible/provisional structures explicitly called out as such.
--   - Enums are TEXT + CHECK, not native Postgres ENUM types. A CHECK
--     constraint amends in one ALTER TABLE; a native enum needs ALTER TYPE
--     ceremony and doesn't play well inside transactions on old PG versions.
--     This schema is meant to be amended often (see the versioned-template
--     pattern below) so we optimise for that.
--   - Every tenant-scoped table is RLS-enabled in §12. Nothing in §1–§11
--     is safe to query without it — that section is not optional polish.
--   - Verified against PostgreSQL 18 (PGlite 0.5.5) end to end; see
--     verify-schema.mjs in the same folder for the harness.
-- ============================================================================

-- gen_random_uuid() is built into Postgres core since v13 — no pgcrypto
-- extension needed. (Verified against the PGlite/PG18 harness in this repo;
-- if you're deploying to something older than PG13, add pgcrypto back.)

-- ============================================================================
-- 1. Roles
--
-- fieldready_migrator: owns every table, used only for migrations/seeding.
--   Table ownership implies BYPASSRLS-equivalent access for DDL and, for a
--   superuser-run migration, for DML too — do not use this role from the API.
-- fieldready_app: the only role the API connects as. RLS-restricted. Every
--   request handler must `SET LOCAL app.current_tenant_id = '<uuid>'` before
--   touching any tenant table, or every tenant-scoped query returns zero rows.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fieldready_app') then
    create role fieldready_app with login password 'change_me_in_deployment';
  end if;
end $$;

-- ============================================================================
-- 2. Tenancy
-- ============================================================================

create table tenant (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  compliance_profile  text not null default 'basic'
                        check (compliance_profile in ('basic', 'ited_ready', 'ited_full')),
  country             text not null default 'PT',
  created_at          timestamptz not null default now()
);

comment on column tenant.compliance_profile is
  'Gates feature visibility (PRD §3 / architecture §3). Not a tenancy mechanism — '
  'RLS below is what actually isolates data. ited_full additionally requires every '
  'referenced test_protocol template_version to carry verified_by (see §12 gate).';

-- ============================================================================
-- 3. Auth
--
-- Two distinct flows, per architecture §2: office users (email/password or
-- magic link) and technician devices (paired by an office invite, then a
-- 4-digit PIN bound to that device). Neither is a full auth implementation —
-- this is the data shape; wire it to whatever session/JWT library Phase 1
-- picks.
-- ============================================================================

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  role          text not null check (role in ('owner', 'office', 'technician')),
  full_name     text not null,
  email         text,
  phone         text,
  -- "N.º (ANACOM, OE, OET)" on the ficha de identificações (ANEXO, Procedimento
  -- Edição 2024, confirmed from the real document 18 Aug — ited-ref-mapping.md
  -- §7A.2). Required on the REF for whichever technician performed the install;
  -- null for office-only users who never appear on a REF.
  professional_registration_number text,
  -- Office auth (architecture §2/§7, API spec §1): bcrypt hash, never the
  -- plaintext. Null for technician-role users, who authenticate via
  -- technician_device.pin_hash instead — a password on both would be two
  -- credentials for one identity with no design reason for it. Magic-link
  -- login (the other office option architecture §2 names) needs no column
  -- here; it's a short-lived token table, added when that flow is built.
  password_hash text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

create table technician_device (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  user_id           uuid not null references app_user(id),
  device_label      text not null,               -- "Rui — telemóvel pessoal"
  pin_hash          text not null,
  paired_at         timestamptz not null default now(),
  paired_by         uuid not null references app_user(id),  -- office user who issued the invite
  revoked_at        timestamptz,
  last_seen_at      timestamptz
);

comment on table technician_device is
  'PIN is a second factor bound to this specific device row, not a standalone '
  'credential (architecture §7). Revoke by setting revoked_at; never delete — '
  'it is evidence of who could have submitted data on a given date.';

-- ============================================================================
-- 4. Template engine
--
-- The core "amendable later" mechanism (architecture §5). Two layers:
-- system templates (tenant_id null, shipped by FieldReady) and tenant
-- templates (owned, optionally forked from a system template). Published
-- versions are immutable; jobs snapshot the version they ran under.
-- ============================================================================

create table template (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenant(id),   -- null = system template
  layer         text not null check (layer in ('system', 'tenant')),
  kind          text not null check (kind in
                  ('checklist', 'test_protocol', 'document_pack',
                   'report_assembly', 'execution_steps', 'deadline_rule')),
  code          text not null,                 -- stable machine key, e.g. 'readiness_tdt_install'
  title         text not null,
  forked_from   uuid references template(id),
  created_at    timestamptz not null default now(),
  check ((layer = 'system' and tenant_id is null) or (layer = 'tenant' and tenant_id is not null)),
  unique (tenant_id, code)
);

create table template_version (
  id              uuid primary key default gen_random_uuid(),
  template_id     uuid not null references template(id),
  version         int not null,
  status          text not null default 'draft'
                    check (status in ('draft', 'active', 'retired')),
  body            jsonb not null,               -- shape depends on template.kind; see §4a below
  effective_from  timestamptz,
  published_at    timestamptz,
  published_by    uuid references app_user(id),
  -- Compliance gate (ited-ref-mapping.md §7A.3): a test_protocol version can only
  -- back an ited_full job once a human has verified its numeric limits against the
  -- real Manual ITED tables. Enforced in application logic at activation time
  -- (see 04-API-SPEC.md, POST /templates/:id/versions/:version/activate) and
  -- backstopped here so a direct DB write can't silently skip it either.
  verified_by     uuid references app_user(id),
  verified_source text,                          -- e.g. "Manual ITED 4ª ed., p.168, Tabela 6.12"
  verified_at     timestamptz,
  unique (template_id, version)
);

create or replace function fn_activate_template_version_guard()
returns trigger as $$
declare
  t_kind text;
begin
  if new.status = 'active' then
    select kind into t_kind from template where id = new.template_id;
    if t_kind = 'test_protocol' and new.verified_by is null then
      raise exception
        'template_version %: cannot activate an unverified test_protocol (ited-ref-mapping.md §7A.3). '
        'Set verified_by/verified_source once the real Manual ITED limits have been confirmed.',
        new.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_activate_template_version_guard
  before insert or update on template_version
  for each row execute function fn_activate_template_version_guard();

comment on table template_version is
  'Immutable once active (architecture §5). Amending a form = new draft version, '
  'published, which retires the old one. Never UPDATE body on an active row.';

-- §4a. `body` shapes by kind (documented, not enforced by a DB constraint —
-- enforce with a Zod schema per kind in packages/core, shared client+server):
--
-- checklist:        { items: [{ id, cat: material|equipment|doc, label, qty,
--                                item_id, scope: job|van|office, mandatory }] }
-- test_protocol:     { network_type: PC|CC|FO|SMATV,
--                       tests: [{ id, label, unit, dir: range|min|max, min, max,
--                                  limit_ref (e.g. "Tabela 6.12") }] }
-- execution_steps:   { steps: [{ order, label }] }
-- document_pack:     { items: [{ label, mandatory, scope }] }
-- report_assembly:   { sections: [{ key, source_table, required }] }
-- deadline_rule:     { clocks: [{ key, trigger_event, days, calendar: pt_working_days }] }

-- ============================================================================
-- 5. Catalog, suppliers, prices, receipts
-- ============================================================================

create table catalog_item (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  sku         text not null,
  name        text not null,
  unit        text not null default 'un',
  created_at  timestamptz not null default now(),
  unique (tenant_id, sku)
);

create table supplier (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  name          text not null,
  category      text,
  address       text,
  phone         text,
  account_note  text,                      -- "Conta 30 dias · desconto 18%"
  -- Google Places sync (architecture §6): place_id is cacheable indefinitely
  -- per Google's terms; everything else needs periodic refresh.
  place_id      text,
  distance_km   numeric(6,2),
  synced_at     timestamptz,
  hours         jsonb,                     -- [{dow:0..6, open:'08:00', close:'18:30'} | null]
  created_at    timestamptz not null default now()
);

create table supplier_price (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  supplier_id   uuid not null references supplier(id),
  item_id       uuid not null references catalog_item(id),
  price         numeric(10,2) not null,
  prev_price    numeric(10,2),
  source        text not null check (source in ('receipt', 'manual')),
  effective_at  timestamptz not null default now(),
  receipt_id    uuid,                       -- fk added after receipt table exists
  created_by    uuid references app_user(id),
  unique (tenant_id, supplier_id, item_id, effective_at)
);

create table receipt (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  supplier_id     uuid references supplier(id),
  doc_number      text,
  receipt_date    date,
  image_file      text not null,             -- object storage key
  ocr_raw         jsonb,                      -- raw OCR vendor response, kept for audit
  status          text not null default 'pending'
                    check (status in ('pending', 'confirmed', 'rejected')),
  confirmed_by    uuid references app_user(id),
  confirmed_at    timestamptz,
  created_at      timestamptz not null default now()
);

alter table supplier_price
  add constraint fk_supplier_price_receipt foreign key (receipt_id) references receipt(id);

create table receipt_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),   -- denormalized from receipt for uniform RLS (see §12)
  receipt_id    uuid not null references receipt(id),
  item_id       uuid references catalog_item(id),   -- null = unmatched line, shown for review
  description   text not null,
  qty           numeric(10,2) not null default 1,
  unit_price    numeric(10,2) not null
);

-- ============================================================================
-- 6. Clients, quotes
-- ============================================================================

create table client (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  name          text not null,
  address       text,
  phone         text,
  email         text,
  created_at    timestamptz not null default now()
);

create table quote (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  client_id         uuid not null references client(id),
  job_type          text not null,             -- "TDT — instalação nova" etc, free text v1
  quoted_hours      numeric(6,2) not null,
  quoted_materials  numeric(10,2) not null,
  status            text not null default 'draft'
                      check (status in ('draft', 'sent', 'accepted', 'declined')),
  accepted_at       timestamptz,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now()
);

create table quote_line (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),   -- denormalized from quote for uniform RLS (see §12)
  quote_id      uuid not null references quote(id),
  item_id       uuid references catalog_item(id),
  description   text not null,
  qty           numeric(10,2) not null default 1,
  planned_supplier_id uuid references supplier(id),
  unit_price    numeric(10,2) not null
);

-- ============================================================================
-- 7. Jobs
-- ============================================================================

create table job (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  quote_id            uuid references quote(id),
  client_id           uuid not null references client(id),
  code                text not null,            -- "JOB-2041", tenant-scoped display id
  title               text not null,
  address             text,
  job_type            text not null,
  scheduled_at        timestamptz,
  quoted_hours        numeric(6,2) not null,
  quoted_materials    numeric(10,2) not null,
  actual_hours        numeric(6,2),
  actual_materials    numeric(10,2),
  assigned_to         uuid references app_user(id),

  status              text not null default 'ready_check'
                        check (status in
                          ('ready_check', 'dispatched', 'in_progress', 'testing',
                           'closed', 'cancelled')),

  -- Job classification per DL 123/2009 (PRD §7 / ited-ref-mapping.md §7A.1).
  -- Default is the safe-over-inclusive one: existing_alteration, not out_of_scope.
  ited_classification text not null default 'existing_alteration'
                        check (ited_classification in
                          ('licensed', 'existing_alteration', 'out_of_scope', 'exempt')),
  ited_classification_note text,     -- required free text if set to out_of_scope or exempt
  ited_classification_by   uuid references app_user(id),  -- office review, never technician-set

  manual_edition      text default 'ITED4',

  -- Denormalized template snapshots, resolved once at dispatch (architecture §5).
  -- Never re-read from `template`/`template_version` after dispatch.
  readiness_snapshot  jsonb,
  execution_snapshot  jsonb,
  test_protocol_snapshot jsonb,

  completed_at        timestamptz,          -- starts the termo 10-working-day clock
  created_at          timestamptz not null default now(),
  unique (tenant_id, code),
  check (
    ited_classification not in ('out_of_scope', 'exempt')
    or ited_classification_note is not null
  )
);

create table job_checklist_item (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  cat           text not null check (cat in ('material', 'equipment', 'doc')),
  label         text not null,
  qty           numeric(10,2) not null default 1,
  item_id       uuid references catalog_item(id),
  scope         text not null check (scope in ('job', 'van', 'office')),
  mandatory     boolean not null default true,
  status        text not null default 'missing' check (status in ('ok', 'missing')),
  updated_by    uuid references app_user(id),
  updated_at    timestamptz
);

comment on table job_checklist_item is
  'Materialized per job from job.readiness_snapshot at dispatch time. scope=job '
  'is the ONLY thing the technician phone UI ever renders — keep that list to '
  '4-6 items per forms-and-procedures-spec.md §3.2. scope=van/office are '
  'informational here (van: audited weekly, not per job; office: auto-verified, '
  'never shown on the phone).';

create table van_audit (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  van_label     text not null,
  performed_by  uuid not null references app_user(id),
  performed_at  timestamptz not null default now(),
  next_due_at   timestamptz not null,
  issues        jsonb not null default '[]'    -- [{item_id, label, note}]
);

-- ============================================================================
-- 8. Equipment and calibration
--
-- REF item (c) requires calibration certificates (ited-ref-mapping.md §3.1).
-- The readiness gate blocks dispatch when a job's test_protocol references an
-- instrument whose calibration has lapsed — enforced in application logic at
-- dispatch (04-API-SPEC.md POST /jobs/:id/dispatch), backstopped by the
-- calibration_expires_on check below being a first-class queryable column.
-- ============================================================================

create table equipment (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenant(id),
  kind                    text not null,           -- "Medidor de campo DVB-T2"
  make                    text,
  model                   text,
  serial                  text,
  supports_export         boolean not null default false,  -- confirmed false fleet-wide, 18 Aug — see architecture §2
  calibration_cert_file   text,                     -- object storage key
  calibration_issued_on   date,
  calibration_expires_on  date,
  created_at              timestamptz not null default now()
);

-- ============================================================================
-- 9. Test protocols & results
-- ============================================================================

create table job_test_result (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  job_id            uuid not null references job(id),
  network_type      text not null check (network_type in ('PC', 'CC', 'FO', 'SMATV')),
  location_label    text not null,          -- "Tomada — Sala"
  test_code         text not null,          -- matches template body test.id
  measured_value    text,                   -- text: some readings are scientific notation strings
  unit              text,
  limit_ref         text,                   -- "Tabela 6.12"
  outcome           text not null default 'pending'
                      check (outcome in ('pass', 'fail', 'pending', 'na')),
  performed_at      timestamptz,
  performed_by      uuid references app_user(id),
  performed_by_entity text,                 -- third-party testing entity, if contracted (REF note 4)
  instrument_id     uuid references equipment(id),
  -- Capture source: photo_ocr leads, manual is the fallback. instrument_export
  -- kept for forward compatibility only — confirmed inactive fleet-wide, 18 Aug
  -- (forms-and-procedures-spec.md §3.4 revision).
  capture_source    text not null default 'manual'
                      check (capture_source in ('instrument_export', 'photo_ocr', 'manual')),
  raw_capture_file  text
);

-- ============================================================================
-- 10. REF / termo / statutory deadlines
-- ============================================================================

create table ref_document (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  job_id              uuid not null references job(id) unique,
  ref_id              text not null,          -- must equal termo_responsabilidade.ref_id_field (below)
  -- Real ANEXO shape, confirmed 18 Aug against the actual Procedimento Edição 2024
  -- document (ited-ref-mapping.md §7A.2) — not a guess. Kept as jsonb rather than
  -- promoted to columns because it's rendered straight into the REF PDF as one
  -- block and the template-versioning pattern (architecture §5) already covers
  -- amending it if ANACOM revises the form. Shape:
  --   installer:   { name, professional_registration_number }
  --   building:    { address, postal_code, locality, manual_ited_applicable }
  --   cabos_instalados: [{ tecnologia: PC|CC|FO, marca_modelo, classe_rpc }]
  --   outros_materiais: [{ designacao, marca_modelo }]
  --     -- designacao one of: Tomadas, RC-PC, RC-CC, RC-FO, RG-PC, RG-CC, RG-FO,
  --     -- "TDT (Antenas, DST e cabeça de rede)", "Tampa da CVM (classe EN124)", CAM, Outros
  --   documentacao_facultativa: text
  --   outras_identificacoes_relevantes: text   -- the ANEXO's free-text page 2
  ficha_fields        jsonb not null default '{}',
  attachments         jsonb not null default '[]',   -- object storage keys
  generated_pdf       text,
  submitted_at        timestamptz,
  submission_subject  text,
  created_at          timestamptz not null default now()
);

create table termo_responsabilidade (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  job_id              uuid not null references job(id) unique,
  number              text not null,
  ref_id_field        text not null,     -- the REF identification this termo declares — must match ref_document.ref_id
  issued_at           timestamptz not null,
  anacom_area_ref      text,              -- manual bridge to ANACOM's reserved area; keep this the ONLY one (architecture §6)
  recipients          jsonb not null default '[]',  -- [{role, name, sent_at}], 5 required parties
  paper_copy_photo    text,               -- evidence photo, copy placed inside ATE/ATI
  created_at          timestamptz not null default now()
);

alter table ref_document
  add constraint fk_ref_matches_termo
  check (true);  -- see trigger below; a CHECK can't reference another table directly

create or replace function fn_ref_termo_reconciliation()
returns trigger as $$
declare
  termo_ref text;
begin
  select ref_id_field into termo_ref from termo_responsabilidade where job_id = new.job_id;
  if termo_ref is not null and termo_ref <> new.ref_id then
    raise exception
      'ref_document.ref_id (%) does not match termo_responsabilidade.ref_id_field (%) for job %. '
      'These must be identical per the Procedimento Edição 2024 note 1 (forms-and-procedures-spec.md F15).',
      new.ref_id, termo_ref, new.job_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_ref_termo_reconciliation
  before insert or update on ref_document
  for each row execute function fn_ref_termo_reconciliation();

create table compliance_deadline (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  kind          text not null check (kind in ('termo', 'ref')),
  due_on        date not null,            -- computed in application logic using a PT working-day calendar
  satisfied_at  timestamptz,
  status        text not null default 'open'
                  check (status in ('open', 'reminder_sent', 'warning_sent', 'overdue', 'satisfied'))
);

comment on table compliance_deadline is
  'Two clocks per job (forms-and-procedures-spec.md F17): termo within 10 working '
  'days of job.completed_at; REF within 10 working days of termo_responsabilidade.issued_at. '
  'PT working-day arithmetic belongs in application code against a maintained holiday '
  'calendar, not in SQL — holiday lists change yearly.';

-- ============================================================================
-- 11. Close-out / AAR / follow-up actions
-- ============================================================================

create table job_closeout (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  job_id            uuid not null references job(id) unique,
  first_time_fix    boolean,
  rework_cause      text,             -- office-assigned taxonomy, NOT technician-set (PRD §6)
  rework_cause_set_by uuid references app_user(id),
  technician_voice_note_file text,
  technician_note_transcript text,
  client_signature_file      text,
  closed_by         uuid references app_user(id),
  closed_at         timestamptz
);

create table follow_up_action (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  description   text not null,
  owner         text,             -- "Escritório", "Compras", or a specific app_user
  owner_user_id uuid references app_user(id),
  due_on        date,
  status        text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  created_at    timestamptz not null default now()
);

create table job_photo (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  phase         text not null check (phase in ('before', 'during', 'after', 'evidence')),
  required_tag  text,             -- e.g. "mast_fixing", "earthing", "ate_interior" — job-type specific
  file          text not null,
  taken_at      timestamptz not null default now(),
  taken_by      uuid references app_user(id)
);

-- ============================================================================
-- 11a. Offline sync — Phase 1 exit criterion (CLAUDE.md, architecture §4/§8,
-- API spec §9). client_mutation_id is generated on-device and used as the
-- primary key so replaying a batch after a killed-mid-sync app restart is
-- idempotent by construction, not by an application-layer check that could
-- be gotten wrong: the second insert of the same id simply fails/upserts
-- against a row that already reflects the applied result.
-- ============================================================================

create table applied_mutation (
  client_mutation_id uuid primary key,     -- client-generated; the idempotency key itself
  tenant_id           uuid not null references tenant(id),
  mutation_type       text not null,
  applied_at          timestamptz not null default now(),
  result              jsonb not null       -- the response row served back on replay, so a retried
                                            -- request gets an identical answer, not a re-derived one
);

comment on table applied_mutation is
  'One row per successfully-processed sync mutation (API spec §9). Existence of a '
  'row for a given client_mutation_id is what makes POST /sync/mutations safe to '
  'call twice with the same batch — the Phase 1 exit criterion this schema exists '
  'to prove (CLAUDE.md Phase 1).';

-- ============================================================================
-- 12. Row-level security
--
-- Applied to every tenant-scoped table. The API connects as fieldready_app
-- and MUST `SET LOCAL app.current_tenant_id = '<uuid>'` per request/transaction
-- (architecture §3) — without it every one of these policies evaluates to
-- false and queries return zero rows, which is the fail-safe direction.
-- ============================================================================

-- `template` and `template_version` are deliberately excluded from the generic
-- loop below: `template` needs an extra OR-clause for system rows (tenant_id
-- is null there by design, §4), and `template_version` has no tenant_id
-- column at all — it inherits scoping through template_id. Both get RLS
-- enabled and a bespoke policy immediately after the loop instead.

do $$
declare
  t text;
  tenant_tables text[] := array[
    'app_user', 'technician_device',
    'catalog_item', 'supplier', 'supplier_price', 'receipt', 'receipt_line',
    'client', 'quote', 'quote_line', 'job', 'job_checklist_item', 'van_audit',
    'equipment', 'job_test_result', 'ref_document', 'termo_responsabilidade',
    'compliance_deadline', 'job_closeout', 'follow_up_action', 'job_photo',
    'applied_mutation'
    -- if you add a table, it needs tenant_id and a place in this array, or the
    -- RLS-coverage check at the bottom of verify-schema.mjs should catch the gap
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = nullif(current_setting(''app.current_tenant_id'', true), '''')::uuid)
         with check (tenant_id = nullif(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      t
    );
    execute format('grant select, insert, update, delete on %I to fieldready_app', t);
  end loop;
end $$;

-- template: tenant rows are scoped normally; system rows (tenant_id null,
-- layer='system') must be readable by every tenant.
alter table template enable row level security;
alter table template force row level security;
create policy tenant_isolation on template
  using (
    tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid
    or (layer = 'system' and tenant_id is null)
  )
  with check (tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid);
grant select, insert, update, delete on template to fieldready_app;

-- template_version: no tenant_id of its own, inherits visibility from its
-- parent template row via the same rule.
alter table template_version enable row level security;
alter table template_version force row level security;
create policy tenant_isolation on template_version
  using (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id
        and (
          tp.tenant_id = nullif(current_setting('app.current_tenant_id', true), '')::uuid
          or (tp.layer = 'system' and tp.tenant_id is null)
        )
    )
  );
grant select, insert, update, delete on template_version to fieldready_app;

grant select on tenant to fieldready_app;   -- tenant row itself: readable, not RLS'd (bootstrap needs it)
grant usage on schema public to fieldready_app;

-- ============================================================================
-- 13. Convenience views — the dashboard reads these, not raw tables
-- ============================================================================

create view v_job_readiness as
select
  j.id as job_id,
  j.tenant_id,
  count(*) filter (where c.mandatory) as mandatory_total,
  count(*) filter (where c.mandatory and c.status = 'ok') as mandatory_ok,
  round(
    100.0 * count(*) filter (where c.mandatory and c.status = 'ok')
    / nullif(count(*) filter (where c.mandatory), 0),
    1
  ) as readiness_pct
from job j
left join job_checklist_item c on c.job_id = j.id
group by j.id, j.tenant_id;

comment on view v_job_readiness is
  'The core headline metric (forms-and-procedures-spec.md dashboard section): '
  'correlate readiness_pct against job_closeout.first_time_fix to reproduce the '
  'prototype''s central argument with real data.';

create view v_first_time_fix_rate as
select
  tenant_id,
  date_trunc('month', closed_at) as month,
  count(*) as jobs_closed,
  count(*) filter (where first_time_fix) as first_time_fixes,
  round(100.0 * count(*) filter (where first_time_fix) / nullif(count(*), 0), 1) as ffr_pct
from job_closeout
where closed_at is not null
group by tenant_id, date_trunc('month', closed_at);

create view v_hours_variance as
select
  j.tenant_id,
  j.job_type,
  count(*) as n,
  avg(j.actual_hours - j.quoted_hours) as avg_hours_delta,
  round(100.0 * avg((j.actual_hours - j.quoted_hours) / nullif(j.quoted_hours, 0)), 1) as avg_pct_variance
from job j
where j.actual_hours is not null
group by j.tenant_id, j.job_type;

grant select on v_job_readiness, v_first_time_fix_rate, v_hours_variance to fieldready_app;

-- ============================================================================
-- 14. Indexes beyond what unique constraints already provide
-- ============================================================================

create index idx_job_tenant_status on job (tenant_id, status);
create index idx_job_scheduled on job (tenant_id, scheduled_at);
create index idx_checklist_job on job_checklist_item (job_id);
create index idx_supplier_price_item on supplier_price (tenant_id, item_id);
create index idx_compliance_deadline_due on compliance_deadline (tenant_id, status, due_on);
create index idx_template_version_active on template_version (template_id, status);

-- ============================================================================
-- End of schema. Seed data for local development lives in seed.sql, kept
-- separate so this file is exactly "what production runs."
-- ============================================================================
