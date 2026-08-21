-- ============================================================================
-- FieldReady — Supabase-native schema
-- §6 Step 1 of 08-supabase-native-migration.md · not yet live, applied in
-- isolation against the real Supabase project only, proven by
-- verify-schema-supabase.mjs in this same folder before apps/web or any
-- Fastify route is pointed at it.
--
-- This is NOT an edit to ../../03-schema.sql — that file, PGlite, and every
-- existing route/proof script are untouched and continue to be the system of
-- record until a later §6 step cuts traffic over slice by slice. This file is
-- a faithful derivative of it with exactly two classes of change, both
-- required by the trust-model shift 08-supabase-native-migration.md §1
-- describes (the browser becomes a first-class Postgres client, RLS becomes
-- the *only* boundary — there is no Fastify decision in front of these
-- tables anymore):
--
--   1. Identity: no `fieldready_app` role / `SET LOCAL app.current_tenant_id`.
--      Office/owner rows carry `app_user.auth_user_id = auth.uid()` (§2/§8 —
--      see §2's comment block below for a correction to §8's original
--      "equal ids" resolution, surfaced while proving this file). Technician
--      identity resolves through the new `technician_device.auth_user_id`
--      column instead, one level removed from app_user entirely (§2). Both
--      paths are unified by fn_current_tenant_id() (§3) so every RLS policy
--      has one shape regardless of which kind of user is asking.
--   2. Every RLS policy is rewritten around fn_current_tenant_id() instead of
--      current_setting('app.current_tenant_id'). `tenant` itself also gains
--      RLS here, which 03-schema.sql deliberately did not need — that table
--      was readable-not-RLS'd there only because Fastify was the sole reader
--      and had already scoped the request before touching SQL. That
--      precondition is gone, so an unrestricted `select` on `tenant` would
--      let any authenticated user in any tenant read every other tenant's
--      name/slug/compliance_profile. Flagged explicitly rather than silently
--      carried over.
--
-- Everything else — table shapes, constraints, triggers (activation guard,
-- REF/termo reconciliation), views, indexes — is copied unchanged. Compliance
-- logic (the whole point of this schema) does not get to drift between the
-- two copies during the migration window; only the access-control layer
-- differs, and only where §1/§2 above require it.
--
-- Known gap, deliberately not resolved here (out of scope for "stand up the
-- schema" — a later §6 slice's job): every policy below grants full
-- select/insert/update/delete to any authenticated member of a tenant,
-- office and technician alike — the same blast radius `fieldready_app` had
-- in 03-schema.sql. Role-differentiated policies (e.g. only office should
-- set job.ited_classification or job_closeout.rework_cause) are not yet
-- split out; CLAUDE.md's "technician never classifies" rule is enforced by
-- pending RPC-function design (08-supabase-native-migration.md §4), not by
-- these table-level grants.
-- ============================================================================

-- ============================================================================
-- 1. Tenancy
-- ============================================================================

create table tenant (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  slug                text not null unique,
  compliance_profile  text not null default 'basic'
                        check (compliance_profile in ('basic', 'ited_ready', 'ited_full')),
  country             text not null default 'PT',
  municipality        text,
  created_at          timestamptz not null default now()
);

comment on column tenant.compliance_profile is
  'Gates feature visibility (PRD §3 / architecture §3). Not a tenancy mechanism — '
  'RLS below is what actually isolates data. ited_full additionally requires every '
  'referenced test_protocol template_version to carry verified_by (see activation '
  'guard trigger below).';

comment on column tenant.municipality is
  'PT município, as a date-holidays subdivision code (e.g. "PT-11" for Lisboa) — '
  'feeds the working-day holiday calendar F17 statutory deadlines are computed '
  'against. Nullable; unset means national-holidays-only.';

-- ============================================================================
-- 2. Auth
--
-- 08-supabase-native-migration.md §2/§8, with one correction to §8's
-- resolution surfaced empirically while proving this file (verify-schema-
-- supabase.mjs's first run against a real technician row): §8 recommended
-- app_user.id == auth.uid() directly, reasoned entirely in terms of office
-- users ("every current office user already requires a working login to
-- exist at all"). That reasoning does not extend to technician rows —
-- under §2's own design, a technician never has a login of their own at
-- all; only their *paired device* does (technician_device.auth_user_id,
-- below). Making app_user.id itself a hard FK to auth.users(id) would force
-- every technician row to also have a standalone Supabase Auth user, which
-- contradicts §2's whole model. Fixed here per §8's *other* named option:
-- app_user.id stays its own independent uuid; a nullable auth_user_id
-- column carries the office-login link — set for office/owner rows
-- (== auth.uid() for whoever's currently signed in), left null for
-- technician rows (whose identity resolves one level removed, through
-- technician_device.auth_user_id instead — see fn_current_tenant_id below).
-- ============================================================================

create table app_user (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  role          text not null check (role in ('owner', 'office', 'technician')),
  full_name     text not null,
  email         text,
  phone         text,
  professional_registration_number text,
  -- Office/owner login link — the id Supabase Auth issued when this
  -- person's account was created (service_role required, §2 — one of the
  -- few remaining server-side calls). Null for technician rows: they have
  -- no login of their own under this design, ever.
  auth_user_id  uuid unique references auth.users(id) on delete cascade,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (tenant_id, email)
);

comment on column app_user.auth_user_id is
  'Office/owner rows only — the Supabase Auth user for this person, set at '
  'account-creation time (auth.uid() equals this when they are signed in). '
  'Null for technician rows by design (§2): a technician never authenticates '
  'as themself, only their paired device does (technician_device.auth_user_id).'
  ' password_hash does not exist here — Supabase Auth owns the credential '
  'entirely for whoever has one, unlike 03-schema.sql''s bcrypt column.';

create table technician_device (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  user_id           uuid not null references app_user(id),
  device_label      text not null,
  -- No pin_hash column here (unlike 03-schema.sql) — the PIN is not stored
  -- redundantly in this table at all; it IS the Supabase Auth password for
  -- auth_user_id, verified by Supabase Auth itself at sign-in. Storing a
  -- second hash of the same secret here would be two sources of truth for
  -- one credential with no design reason for it.
  auth_user_id      uuid not null unique references auth.users(id),
  paired_at         timestamptz not null default now(),
  paired_by         uuid not null references app_user(id),
  revoked_at        timestamptz,
  last_seen_at      timestamptz
);

comment on table technician_device is
  'PIN is a second factor bound to this specific device row via auth_user_id, '
  'not a standalone credential (architecture §7). Revoke by setting revoked_at; '
  'never delete — it is evidence of who could have submitted data on a given '
  'date. auth_user_id has no ON DELETE action (not cascade, not set null) '
  'specifically so that invariant cannot be silently defeated by deleting the '
  'underlying auth user out from under an audit row — revoke it instead.';

-- Security review finding (auth-flow-correctness, confirmed): nothing
-- otherwise ties technician_device.tenant_id to the tenant of the app_user
-- row user_id points at, yet fn_current_tenant_id()'s technician branch
-- resolves tenant through THAT app_user row (au.tenant_id), not through
-- technician_device.tenant_id itself. A mismatched pairing (tenant_id set to
-- tenant A, user_id pointing at a tenant-B app_user) would silently resolve
-- the device's session to tenant B — while the device row itself becomes
-- invisible under its own table's tenant_isolation policy (which filters on
-- tenant A), making the misconfiguration undetectable from the table it's
-- in. Closed with one guard, same "single place for a mistake to hide"
-- reasoning as fn_current_tenant_id() itself, rather than trusting every
-- future INSERT/UPDATE call site to get the join right by hand.
create or replace function fn_technician_device_tenant_guard()
returns trigger as $$
declare
  user_tenant_id uuid;
begin
  select tenant_id into user_tenant_id from app_user where id = new.user_id;
  if user_tenant_id is null or user_tenant_id <> new.tenant_id then
    raise exception
      'technician_device %: tenant_id (%) does not match the tenant of the referenced app_user (%). '
      'A device must be paired to a technician in its own tenant.',
      new.id, new.tenant_id, user_tenant_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_technician_device_tenant_guard
  before insert or update on technician_device
  for each row execute function fn_technician_device_tenant_guard();

-- ============================================================================
-- 2a. fn_current_tenant_id() — the one place identity resolution happens.
-- 08-supabase-native-migration.md §3, verbatim.
--
-- security definer + a pinned search_path: this function must read app_user
-- and technician_device regardless of the RLS on those tables themselves (it
-- IS how tenant_id gets resolved in the first place — without the bypass, a
-- brand-new request couldn't even read its own app_user row to find out
-- which tenant it's in). Pinning search_path is required security practice
-- for any security definer function (unpinned, it's a classic privilege-
-- escalation vector via search_path hijacking) — this is the only function
-- in the whole schema that intentionally runs elevated; anything else
-- needing elevated access is a design smell worth stopping on, per the
-- design doc's own words.
-- ============================================================================

create or replace function fn_current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select tenant_id from app_user where auth_user_id = auth.uid() and active),
    (select au.tenant_id
       from technician_device td
       join app_user au on au.id = td.user_id
      where td.auth_user_id = auth.uid()
        and td.revoked_at is null
        and au.active)
  );
$$;

comment on function fn_current_tenant_id() is
  'Both branches re-check liveness on every call, not just at sign-in: '
  'td.revoked_at is null for a technician''s device, and `active` for both '
  'branches'' underlying app_user row (a deactivated office/owner OR the '
  'person record behind a technician device). A still-valid Supabase session '
  'token issued before either flag flipped stays technically unexpired — '
  'security review confirmed the office branch was missing its half of this '
  'entirely in an earlier draft. Every policy that calls this function '
  'inherits the re-check on every request, per '
  '08-supabase-native-migration.md §2/§3.';

-- fn_current_app_user_id() — §6 Step 4 addition. Several of Step 4's RPC
-- functions (rpc_test_result_record, rpc_execution_step_complete,
-- rpc_closeout_submit — rpc.sql) need to record WHO performed an action
-- (performed_by/completed_by/closed_by, each an FK to app_user(id)), the
-- same way their Fastify-era equivalents stamp req.auth!.user_id. That id
-- is NOT auth.uid() for anyone under this schema — office rows have their
-- own independent app_user.id with a separate auth_user_id column (§2), and
-- technician rows resolve through technician_device entirely. Same two-
-- branch shape and same liveness re-checks as fn_current_tenant_id(), just
-- returning `id` instead of `tenant_id` — kept as a sibling function rather
-- than folding a second return value into fn_current_tenant_id() itself, so
-- policies that only ever need tenant_id (the vast majority, per §12) don't
-- pay for or depend on the extra lookup.
create or replace function fn_current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select id from app_user where auth_user_id = auth.uid() and active),
    (select au.id
       from technician_device td
       join app_user au on au.id = td.user_id
      where td.auth_user_id = auth.uid()
        and td.revoked_at is null
        and au.active)
  );
$$;

-- ============================================================================
-- 3. Template engine — unchanged from 03-schema.sql §4/§4a except RLS (§6 below)
-- ============================================================================

create table template (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references tenant(id),
  layer         text not null check (layer in ('system', 'tenant')),
  kind          text not null check (kind in
                  ('checklist', 'test_protocol', 'document_pack',
                   'report_assembly', 'execution_steps', 'deadline_rule')),
  code          text not null,
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
  body            jsonb not null,
  effective_from  timestamptz,
  published_at    timestamptz,
  published_by    uuid references app_user(id),
  verified_by     uuid references app_user(id),
  verified_source text,
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

-- ============================================================================
-- 4. Catalog, suppliers, prices, receipts — unchanged from 03-schema.sql §5
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
  account_note  text,
  place_id      text,
  distance_km   numeric(6,2),
  synced_at     timestamptz,
  hours         jsonb,
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
  receipt_id    uuid,
  created_by    uuid references app_user(id),
  unique (tenant_id, supplier_id, item_id, effective_at)
);

create table receipt (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenant(id),
  supplier_id     uuid references supplier(id),
  doc_number      text,
  receipt_date    date,
  image_file      text not null,
  ocr_raw         jsonb,
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
  tenant_id     uuid not null references tenant(id),
  receipt_id    uuid not null references receipt(id),
  item_id       uuid references catalog_item(id),
  description   text not null,
  qty           numeric(10,2) not null default 1,
  unit_price    numeric(10,2) not null
);

-- ============================================================================
-- 5. Clients, quotes — unchanged from 03-schema.sql §6
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
  job_type          text not null,
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
  tenant_id     uuid not null references tenant(id),
  quote_id      uuid not null references quote(id),
  item_id       uuid references catalog_item(id),
  description   text not null,
  qty           numeric(10,2) not null default 1,
  planned_supplier_id uuid references supplier(id),
  unit_price    numeric(10,2) not null
);

-- ============================================================================
-- 6. Jobs — unchanged from 03-schema.sql §7
-- ============================================================================

create table job (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  quote_id            uuid references quote(id),
  client_id           uuid not null references client(id),
  code                text not null,
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

  ited_classification text not null default 'existing_alteration'
                        check (ited_classification in
                          ('licensed', 'existing_alteration', 'out_of_scope', 'exempt')),
  ited_classification_note text,
  ited_classification_by   uuid references app_user(id),

  manual_edition      text default 'ITED4',

  readiness_snapshot  jsonb,
  execution_snapshot  jsonb,
  test_protocol_snapshot jsonb,

  completed_at        timestamptz,
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

create table van_audit (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  van_label     text not null,
  performed_by  uuid not null references app_user(id),
  performed_at  timestamptz not null default now(),
  next_due_at   timestamptz not null,
  issues        jsonb not null default '[]'
);

-- ============================================================================
-- 7. Equipment and calibration — unchanged from 03-schema.sql §8
-- ============================================================================

create table equipment (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenant(id),
  kind                    text not null,
  make                    text,
  model                   text,
  serial                  text,
  supports_export         boolean not null default false,
  calibration_cert_file   text,
  calibration_issued_on   date,
  calibration_expires_on  date,
  created_at              timestamptz not null default now()
);

-- ============================================================================
-- 8. Test protocols & results — unchanged from 03-schema.sql §9
-- ============================================================================

create table job_test_result (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  job_id            uuid not null references job(id),
  network_type      text not null check (network_type in ('PC', 'CC', 'FO', 'SMATV')),
  location_label    text not null,
  test_code         text not null,
  measured_value    text,
  unit              text,
  limit_ref         text,
  outcome           text not null default 'pending'
                      check (outcome in ('pass', 'fail', 'pending', 'na')),
  performed_at      timestamptz,
  performed_by      uuid references app_user(id),
  performed_by_entity text,
  instrument_id     uuid references equipment(id),
  capture_source    text not null default 'manual'
                      check (capture_source in ('instrument_export', 'photo_ocr', 'manual')),
  raw_capture_file  text
);

-- ============================================================================
-- 9. REF / termo / statutory deadlines — unchanged from 03-schema.sql §10/10a
-- ============================================================================

create table ref_document (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  job_id              uuid not null references job(id) unique,
  ref_id              text not null,
  ficha_fields        jsonb not null default '{}',
  attachments         jsonb not null default '[]',
  generated_pdf       text,
  submitted_at        timestamptz,
  submission_subject  text,
  rotulo_affixed      boolean,
  created_at          timestamptz not null default now()
);

comment on column ref_document.rotulo_affixed is
  'F18 — whether the rótulo was affixed at the installation. Null = not yet '
  'recorded, not "no".';

create table termo_responsabilidade (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenant(id),
  job_id              uuid not null references job(id) unique,
  number              text not null,
  ref_id_field        text not null,
  issued_at           timestamptz not null,
  anacom_area_ref     text,
  recipients          jsonb not null default '[]',
  paper_copy_photo    text,
  created_at          timestamptz not null default now()
);

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

create or replace function fn_termo_ref_reconciliation()
returns trigger as $$
declare
  existing_ref_id text;
begin
  select ref_id into existing_ref_id from ref_document where job_id = new.job_id;
  if existing_ref_id is not null and existing_ref_id <> new.ref_id_field then
    raise exception
      'ref_document.ref_id (%) does not match termo_responsabilidade.ref_id_field (%) for job %. '
      'These must be identical per the Procedimento Edição 2024 note 1 (forms-and-procedures-spec.md F15).',
      existing_ref_id, new.ref_id_field, new.job_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_termo_ref_reconciliation
  before insert or update on termo_responsabilidade
  for each row execute function fn_termo_ref_reconciliation();

create table compliance_deadline (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  kind          text not null check (kind in ('termo', 'ref')),
  due_on        date not null,
  satisfied_at  timestamptz,
  status        text not null default 'open'
                  check (status in ('open', 'reminder_sent', 'warning_sent', 'overdue', 'satisfied'))
);

-- ============================================================================
-- 10. Close-out / AAR / follow-up actions — unchanged from 03-schema.sql §11
-- ============================================================================

create table job_closeout (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenant(id),
  job_id            uuid not null references job(id) unique,
  first_time_fix    boolean,
  rework_cause      text,
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
  owner         text,
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
  required_tag  text,
  file          text not null,
  taken_at      timestamptz not null default now(),
  taken_by      uuid references app_user(id)
);

-- ============================================================================
-- 11. Offline sync + execution-step completion — unchanged from
-- 03-schema.sql §11a/§11b. applied_mutation's role does not go away in the
-- Supabase-native world — it is what the ported RPC functions
-- (08-supabase-native-migration.md §4) key their idempotency on, same
-- mechanism, just called via supabase.rpc(...) instead of a Fastify route.
-- ============================================================================

create table applied_mutation (
  client_mutation_id uuid primary key,
  tenant_id           uuid not null references tenant(id),
  mutation_type       text not null,
  applied_at          timestamptz not null default now(),
  result              jsonb not null
);

create table job_execution_step_completion (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  job_id        uuid not null references job(id),
  step_order    int not null,
  completed_at  timestamptz not null default now(),
  completed_by  uuid references app_user(id),
  unique (job_id, step_order)
);

-- ============================================================================
-- 12. Row-level security — the actual point of this file.
--
-- No role bootstrap here (03-schema.sql §1) — Supabase already provides
-- `anon`, `authenticated`, `service_role`. Grants below go to `authenticated`
-- only; `anon` gets nothing (no self-serve/public access model exists for
-- this product) and `service_role` bypasses RLS by Supabase's own platform
-- guarantee, not by anything granted here.
-- ============================================================================

do $$
declare
  t text;
  tenant_tables text[] := array[
    'app_user', 'technician_device',
    'catalog_item', 'supplier', 'supplier_price', 'receipt', 'receipt_line',
    'client', 'quote', 'quote_line', 'job', 'job_checklist_item', 'van_audit',
    'equipment', 'job_test_result', 'ref_document', 'termo_responsabilidade',
    'compliance_deadline', 'job_closeout', 'follow_up_action', 'job_photo',
    'applied_mutation', 'job_execution_step_completion'
    -- same 22-table list as 03-schema.sql §12 — if you add a table there,
    -- add it here too, or verify-schema-supabase.mjs's RLS-coverage check
    -- should catch the gap.
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I
         using (tenant_id = fn_current_tenant_id())
         with check (tenant_id = fn_current_tenant_id())',
      t
    );
    execute format('grant select, insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

-- fn_current_tenant_id() is security definer, owned by whichever role applies
-- this migration (the direct-connection superuser role) — its elevated read
-- of app_user/technician_device works by inheriting that owner's normal
-- exemption from RLS, and FORCE ROW LEVEL SECURITY (set on every tenant
-- table by the loop above, deliberately, for defense in depth) specifically
-- strips that owner exemption. Without carving these two tables back out,
-- the helper function couldn't resolve identity on its own first query —
-- a chicken-and-egg break that would fail silently as "everyone gets zero
-- rows", not as an obvious error. This does not weaken isolation for real
-- traffic: PostgREST/Supabase client requests always connect as `anon`,
-- `authenticated`, or `service_role`, never literally as the owning role, so
-- the only things this exemption actually reaches are migration scripts
-- (already fully trusted) and this one function (which needs exactly this).
alter table app_user no force row level security;
alter table technician_device no force row level security;

-- template: tenant rows are scoped normally; system rows (tenant_id null,
-- layer='system') must be readable by every tenant, but — security review
-- finding, critical, confirmed by reproducing the exploit against a real
-- Postgres RLS engine — NEVER writable by one. A single USING/WITH CHECK
-- policy covering every command was wrong here: Postgres defaults an
-- omitted WITH CHECK to the USING expression, and even the explicit WITH
-- CHECK this file had only constrained the *new* row's tenant_id, not
-- whether the *old* row being touched was a system row — which let any
-- tenant UPDATE a system template's layer/tenant_id to hijack it into their
-- own tenant, and let DELETE (which only ever evaluates USING) remove any
-- system template outright. Fixed by splitting into per-command policies:
-- SELECT keeps the system-row exception (that's the one thing system rows
-- are *for*); INSERT/UPDATE/DELETE do not — a system row can never be the
-- target of a write from an authenticated-role session at all, regardless
-- of whose tenant they claim to be writing into. Only a role that bypasses
-- RLS entirely (service_role, or the schema-applying superuser) can ever
-- write a system template — exactly the intended model (system templates
-- are platform-managed, not tenant-managed).
alter table template enable row level security;
alter table template force row level security;

create policy template_select on template for select
  using (
    tenant_id = fn_current_tenant_id()
    or (layer = 'system' and tenant_id is null)
  );
create policy template_insert on template for insert
  with check (tenant_id = fn_current_tenant_id());
create policy template_update on template for update
  using (tenant_id = fn_current_tenant_id())
  with check (tenant_id = fn_current_tenant_id());
create policy template_delete on template for delete
  using (tenant_id = fn_current_tenant_id());

grant select, insert, update, delete on template to authenticated;

-- template_version: no tenant_id of its own, inherits visibility from its
-- parent template row via the same rule — and the same SELECT-only system
-- exception applies: INSERT/UPDATE/DELETE require the referenced template
-- to belong to the caller's own tenant, never a system template, for
-- exactly the reasoning above. This also closes the specific activation-
-- gate abuse the security review found: without this, any tenant could
-- INSERT a new version row (or UPDATE an existing one) against a seeded
-- system test_protocol template and self-satisfy the verified_by trigger
-- guard by citing their own app_user.id — an attacker-controlled row
-- masquerading as a verified Manual ITED limit, shared platform-wide.
alter table template_version enable row level security;
alter table template_version force row level security;

create policy template_version_select on template_version for select
  using (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id
        and (
          tp.tenant_id = fn_current_tenant_id()
          or (tp.layer = 'system' and tp.tenant_id is null)
        )
    )
  );
create policy template_version_insert on template_version for insert
  with check (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id and tp.tenant_id = fn_current_tenant_id()
    )
  );
create policy template_version_update on template_version for update
  using (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id and tp.tenant_id = fn_current_tenant_id()
    )
  )
  with check (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id and tp.tenant_id = fn_current_tenant_id()
    )
  );
create policy template_version_delete on template_version for delete
  using (
    exists (
      select 1 from template tp
      where tp.id = template_version.template_id and tp.tenant_id = fn_current_tenant_id()
    )
  );

grant select, insert, update, delete on template_version to authenticated;

-- tenant: RLS'd here (03-schema.sql's equivalent grant was deliberately not
-- RLS'd — see this file's header comment for why that's no longer safe once
-- the browser reads it directly).
alter table tenant enable row level security;
alter table tenant force row level security;
create policy tenant_isolation on tenant
  using (id = fn_current_tenant_id());
grant select on tenant to authenticated;

grant usage on schema public to authenticated;

-- ============================================================================
-- 13. Convenience views — logic unchanged from 03-schema.sql §13/§13a, but
-- every view here is created `with (security_invoker = true)` (PG15+),
-- which this file's first draft did NOT do — security review, confirmed
-- critical/high: a plain view (the previous shape) authorizes its
-- underlying-table access as the view's OWNER, not the querying session.
-- Whether that accidentally still enforced tenant isolation depended
-- entirely on whether the owning role (the schema-applying connection)
-- carries SUPERUSER/BYPASSRLS — an unstated, unverified assumption a
-- reviewer reproduced failing against a real Postgres instance. Not a
-- decision this schema should leave implicit: security_invoker=true makes
-- every one of these views evaluate permissions AND RLS as the actual
-- calling session, unconditionally, so a tenant A user querying
-- v_job_readiness only ever sees tenant A's join results regardless of who
-- owns the view.
-- ============================================================================

create view v_job_readiness with (security_invoker = true) as
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

create view v_first_time_fix_rate with (security_invoker = true) as
select
  tenant_id,
  date_trunc('month', closed_at) as month,
  count(*) as jobs_closed,
  count(*) filter (where first_time_fix) as first_time_fixes,
  round(100.0 * count(*) filter (where first_time_fix) / nullif(count(*), 0), 1) as ffr_pct
from job_closeout
where closed_at is not null
group by tenant_id, date_trunc('month', closed_at);

create view v_hours_variance with (security_invoker = true) as
select
  j.tenant_id,
  j.job_type,
  count(*) as n,
  avg(j.actual_hours - j.quoted_hours) as avg_hours_delta,
  round(100.0 * avg((j.actual_hours - j.quoted_hours) / nullif(j.quoted_hours, 0)), 1) as avg_pct_variance
from job j
where j.actual_hours is not null
group by j.tenant_id, j.job_type;

create view v_price_alerts with (security_invoker = true) as
select sp.tenant_id, sp.item_id, sp.supplier_id, sp.price, sp.prev_price,
       round(100.0 * (sp.price - sp.prev_price) / nullif(sp.prev_price, 0), 1) as delta_pct
from supplier_price sp
where sp.prev_price is not null and sp.price > sp.prev_price * 1.03;

create view v_readiness_correlation with (security_invoker = true) as
select
  jr.tenant_id,
  case when jr.readiness_pct = 100 then 'gated' else 'ungated' end as readiness_bucket,
  count(*) as jobs,
  count(*) filter (where not jc.first_time_fix) as rework_jobs,
  round(100.0 * count(*) filter (where not jc.first_time_fix) / nullif(count(*), 0), 1) as rework_pct
from v_job_readiness jr
join job_closeout jc on jc.job_id = jr.job_id
where jc.closed_at is not null
  and jr.readiness_pct is not null
group by jr.tenant_id, case when jr.readiness_pct = 100 then 'gated' else 'ungated' end;

grant select on v_job_readiness, v_first_time_fix_rate, v_hours_variance,
  v_price_alerts, v_readiness_correlation to authenticated;

-- ============================================================================
-- 14. Indexes — unchanged from 03-schema.sql §14
-- ============================================================================

create index idx_job_tenant_status on job (tenant_id, status);
create index idx_job_scheduled on job (tenant_id, scheduled_at);
create index idx_checklist_job on job_checklist_item (job_id);
create index idx_supplier_price_item on supplier_price (tenant_id, item_id);
create index idx_compliance_deadline_due on compliance_deadline (tenant_id, status, due_on);
create index idx_template_version_active on template_version (template_id, status);

-- ============================================================================
-- End of schema. No seed data here yet (parallels 03-schema.sql/seed.sql's
-- separation) — seeding real system templates (F13/F14 verified test
-- protocols) against this schema is part of proving §6 Step 1, done by
-- verify-schema-supabase.mjs itself so the proof and the seed can't drift
-- apart, rather than a separate seed-supabase.sql file at this stage.
-- ============================================================================
