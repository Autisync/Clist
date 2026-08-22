// FieldReady — (re)applies rpc.sql to the real Supabase project. §6 Step 5.
//
// Idempotent (every function uses `create or replace`) — safe to run any
// time, including to pick up a newly-added function (e.g. rpc_job_complete)
// without disturbing any function whose definition hasn't changed.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-rpc.mjs

import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const db = new Client(pgClientConfig(projectRef, dbPassword));
await db.connect();

try {
  const rpcPath = new URL('./rpc.sql', import.meta.url).pathname;
  const rpcSql = readFileSync(rpcPath, 'utf8');
  await db.query(rpcSql);
  const r = await db.query(`
    select p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'rpc_%'
    order by p.proname;
  `);
  console.log(`rpc.sql applied. RPC functions now present (${r.rows.length}):`);
  for (const row of r.rows) console.log(`  ${row.proname}`);
} finally {
  await db.end();
}
