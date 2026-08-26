// FieldReady — applies the platform-admin cross-tenant job-read policy
// (schema.sql, right after support_ticket_message's grant, §11a/§12) to the
// real Supabase project.
//
// Same "additive only, never verify-schema-supabase.mjs's destructive
// reset" reasoning as apply-support-tickets.mjs's own header comment — this
// project is shared with at least one other concurrent session, so the
// only safe operation here is a targeted, idempotent addition. `drop
// policy if exists` before `create policy` is what makes this safe to run
// any number of times; nothing here touches an existing table's data or
// any other policy.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-admin-analytics.mjs

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const sql = `
drop policy if exists job_platform_admin_read on job;
create policy job_platform_admin_read on job
  for select
  using (fn_is_platform_admin());
`;

const client = new Client(pgClientConfig(projectRef, dbPassword));

async function main() {
  await client.connect();
  await client.query(sql);
  console.log('Applied: job_platform_admin_read policy.');

  const { rows } = await client.query(
    `select polname from pg_policy where polrelid = 'job'::regclass and polname = 'job_platform_admin_read'`
  );
  if (rows.length !== 1) {
    throw new Error('job_platform_admin_read policy not found after apply.');
  }
  console.log('Verified: job_platform_admin_read exists on job.');
}

main()
  .then(() => client.end())
  .catch(async (err) => {
    console.error(err);
    await client.end();
    process.exit(1);
  });
