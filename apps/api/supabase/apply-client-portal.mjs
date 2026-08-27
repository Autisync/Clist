// FieldReady — applies the client-facing portal's one schema addition
// (job.client_access_token; schema.sql, right after job.created_at) to
// the real Supabase project. The two RPCs this feature also needs
// (rpc_job_generate_client_link, fn_track_job) are already in rpc.sql —
// apply those with the existing `npm run apply:rpc-supabase`, not this
// script.
//
// Same "additive only, never verify-schema-supabase.mjs's destructive
// reset" reasoning as every other apply-*.mjs script's own header comment
// — `alter table ... add column if not exists` is naturally idempotent,
// safe to run any number of times, touches nothing else on job.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-client-portal.mjs

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const sql = `
alter table job add column if not exists client_access_token uuid unique;
`;

const client = new Client(pgClientConfig(projectRef, dbPassword));

async function main() {
  await client.connect();
  await client.query(sql);
  console.log('Applied: job.client_access_token column.');

  const { rows } = await client.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'job' and column_name = 'client_access_token';`
  );
  if (rows.length !== 1) {
    throw new Error('job.client_access_token column not found after apply.');
  }
  console.log('Verified: job.client_access_token exists.');
  console.log('Now run: npm run apply:rpc-supabase   (adds rpc_job_generate_client_link, fn_track_job)');
}

main()
  .then(() => client.end())
  .catch(async (err) => {
    console.error(err);
    await client.end();
    process.exit(1);
  });
