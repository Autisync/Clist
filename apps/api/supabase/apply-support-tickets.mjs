// FieldReady — applies the support-ticket schema addition (schema.sql
// §11a, fn_current_platform_admin_id §2b) to the real Supabase project.
//
// Deliberately NOT "re-run schema.sql via verify-schema-supabase.mjs" —
// that script drops and recreates every table it owns, which is now a
// hard-refused operation once any real tenant exists on this project (see
// its own header comment and the guard added right after a real incident:
// this project is shared with at least one other concurrent session, and
// a full reset would destroy their data too, not just this session's own
// test fixtures). This script instead runs ONLY the new, additive SQL
// support tickets need — every statement below is idempotent (`create
// table if not exists`, `create or replace function`, `drop policy if
// exists` before each `create policy`), safe to run any number of times,
// and touches nothing that already existed before this feature. Mirrors
// apply-rpc.mjs's own safe idiom for exactly this reason, just hand-
// written instead of reading a whole file, since schema.sql itself is
// NOT idempotent as a whole (most of it is plain `create table`, correct
// for a genuinely fresh install, wrong for a targeted addition to a live
// project).
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-support-tickets.mjs

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const sql = `
create or replace function fn_current_platform_admin_id()
returns uuid
language sql
stable
as $fn$
  select id from platform_admin where auth_user_id = auth.uid();
$fn$;

revoke execute on function fn_current_platform_admin_id() from public;
grant execute on function fn_current_platform_admin_id() to authenticated;

create table if not exists support_ticket (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenant(id),
  created_by    uuid not null references app_user(id) default fn_current_app_user_id(),
  subject       text not null,
  body          text not null,
  status        text not null default 'open'
                  check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists support_ticket_message (
  id                        uuid primary key default gen_random_uuid(),
  ticket_id                 uuid not null references support_ticket(id) on delete cascade,
  tenant_id                 uuid not null,
  sender_app_user_id        uuid references app_user(id) default fn_current_app_user_id(),
  sender_platform_admin_id  uuid references platform_admin(id) default fn_current_platform_admin_id(),
  body                      text not null,
  created_at                timestamptz not null default now(),
  check (num_nonnulls(sender_app_user_id, sender_platform_admin_id) = 1)
);

create or replace function fn_support_ticket_message_tenant_guard()
returns trigger as $fn$
declare
  v_ticket_tenant_id uuid;
begin
  select tenant_id into v_ticket_tenant_id from support_ticket where id = new.ticket_id;
  if v_ticket_tenant_id is null then
    raise exception 'support_ticket_message: ticket % does not exist', new.ticket_id;
  end if;
  new.tenant_id := v_ticket_tenant_id;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_support_ticket_message_tenant_guard on support_ticket_message;
create trigger trg_support_ticket_message_tenant_guard
  before insert or update on support_ticket_message
  for each row execute function fn_support_ticket_message_tenant_guard();

alter table support_ticket enable row level security;
alter table support_ticket force row level security;

drop policy if exists tenant_isolation on support_ticket;
create policy tenant_isolation on support_ticket
  using (tenant_id = fn_current_tenant_id())
  with check (tenant_id = fn_current_tenant_id());

drop policy if exists support_ticket_platform_admin_read on support_ticket;
create policy support_ticket_platform_admin_read on support_ticket
  for select
  using (fn_is_platform_admin());

drop policy if exists support_ticket_platform_admin_update on support_ticket;
create policy support_ticket_platform_admin_update on support_ticket
  for update
  using (fn_is_platform_admin());

grant select, insert, update, delete on support_ticket to authenticated;
alter table support_ticket alter column tenant_id set default fn_current_tenant_id();
alter table support_ticket alter column created_by set default fn_current_app_user_id();

alter table support_ticket_message enable row level security;
alter table support_ticket_message force row level security;

-- Superseded policy name from the first apply pass — dropped outright if
-- present, replaced by the split SELECT/INSERT policies below (a real
-- spoofing gap found reviewing this before it ever reached real use: the
-- original bare policy only checked tenant_id, not that the sender
-- columns actually matched the caller's own identity).
drop policy if exists support_ticket_message_tenant_isolation on support_ticket_message;

drop policy if exists support_ticket_message_tenant_read on support_ticket_message;
create policy support_ticket_message_tenant_read on support_ticket_message
  for select
  using (tenant_id = fn_current_tenant_id());

drop policy if exists support_ticket_message_tenant_insert on support_ticket_message;
create policy support_ticket_message_tenant_insert on support_ticket_message
  for insert
  with check (
    tenant_id = fn_current_tenant_id()
    and sender_app_user_id is not distinct from fn_current_app_user_id()
    and sender_platform_admin_id is not distinct from fn_current_platform_admin_id()
  );

drop policy if exists support_ticket_message_platform_admin_read on support_ticket_message;
create policy support_ticket_message_platform_admin_read on support_ticket_message
  for select
  using (fn_is_platform_admin());

drop policy if exists support_ticket_message_platform_admin_insert on support_ticket_message;
create policy support_ticket_message_platform_admin_insert on support_ticket_message
  for insert
  with check (
    fn_is_platform_admin()
    and sender_app_user_id is null
    and sender_platform_admin_id = fn_current_platform_admin_id()
  );

grant select, insert on support_ticket_message to authenticated;

create index if not exists idx_support_ticket_tenant_status on support_ticket (tenant_id, status);
create index if not exists idx_support_ticket_message_ticket on support_ticket_message (ticket_id);
`;

const db = new Client(pgClientConfig(projectRef, dbPassword));
await db.connect();

try {
  await db.query(sql);
  const check = await db.query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name in ('support_ticket', 'support_ticket_message')
    order by table_name;
  `);
  const fnCheck = await db.query(`
    select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and proname in ('fn_current_platform_admin_id', 'fn_support_ticket_message_tenant_guard')
    order by proname;
  `);
  console.log('Support-ticket schema applied. Tables present:', check.rows.map((r) => r.table_name).join(', '));
  console.log('Functions present:', fnCheck.rows.map((r) => r.proname).join(', '));
} finally {
  await db.end();
}
