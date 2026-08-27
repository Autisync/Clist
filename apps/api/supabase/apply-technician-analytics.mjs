// FieldReady — applies the two per-technician dashboard views
// (v_first_time_fix_rate_by_technician, v_hours_variance_by_technician;
// schema.sql, right after v_readiness_correlation) to the real Supabase
// project.
//
// Same "additive only, never verify-schema-supabase.mjs's destructive
// reset" reasoning as every other apply-*.mjs script's own header comment
// — this project is shared with at least one other concurrent session, so
// the only safe operation here is a targeted, idempotent addition.
// `create or replace view` is naturally idempotent (unlike `create table`,
// which needs `if not exists`); the two `grant`/`drop policy` idioms other
// apply scripts use for tables don't apply here at all — views inherit
// their access from the underlying tables' own RLS (security_invoker =
// true), so the only privilege that needs granting is SELECT on the view
// object itself, also idempotent to re-grant.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-technician-analytics.mjs

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const sql = `
create or replace view v_first_time_fix_rate_by_technician with (security_invoker = true) as
select
  jc.tenant_id,
  jc.closed_by as technician_id,
  au.full_name as technician_name,
  date_trunc('month', jc.closed_at) as month,
  count(*) as jobs_closed,
  count(*) filter (where jc.first_time_fix) as first_time_fixes,
  round(100.0 * count(*) filter (where jc.first_time_fix) / nullif(count(*), 0), 1) as ffr_pct
from job_closeout jc
join app_user au on au.id = jc.closed_by
where jc.closed_at is not null
group by jc.tenant_id, jc.closed_by, au.full_name, date_trunc('month', jc.closed_at);

create or replace view v_hours_variance_by_technician with (security_invoker = true) as
select
  j.tenant_id,
  j.assigned_to as technician_id,
  au.full_name as technician_name,
  count(*) as n,
  avg(j.actual_hours - j.quoted_hours) as avg_hours_delta,
  round(100.0 * avg((j.actual_hours - j.quoted_hours) / nullif(j.quoted_hours, 0)), 1) as avg_pct_variance
from job j
join app_user au on au.id = j.assigned_to
where j.actual_hours is not null and j.assigned_to is not null
group by j.tenant_id, j.assigned_to, au.full_name;

grant select on v_first_time_fix_rate_by_technician, v_hours_variance_by_technician to authenticated;
`;

const client = new Client(pgClientConfig(projectRef, dbPassword));

async function main() {
  await client.connect();
  await client.query(sql);
  console.log('Applied: v_first_time_fix_rate_by_technician, v_hours_variance_by_technician.');

  const { rows } = await client.query(
    `select table_name from information_schema.views where table_schema = 'public' and table_name in ('v_first_time_fix_rate_by_technician', 'v_hours_variance_by_technician') order by table_name;`
  );
  if (rows.length !== 2) {
    throw new Error(`Expected both views to exist after apply, found: ${JSON.stringify(rows)}`);
  }
  console.log('Verified: both views exist in public schema.');
}

main()
  .then(() => client.end())
  .catch(async (err) => {
    console.error(err);
    await client.end();
    process.exit(1);
  });
