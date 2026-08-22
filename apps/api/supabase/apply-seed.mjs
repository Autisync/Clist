// FieldReady — applies seed.sql (real F11-F14 reference data) to the real
// Supabase project. §6 Step 5.
//
// Idempotent (seed.sql itself uses `on conflict (id) do nothing`) — safe to
// run any time, including as part of a fresh environment's setup, without
// risk of duplicating the real reference data.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/apply-seed.mjs

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
  const seedPath = new URL('./seed.sql', import.meta.url).pathname;
  const seedSql = readFileSync(seedPath, 'utf8');
  await db.query(seedSql);
  const r = await db.query(`select code, title from template where layer = 'system' order by code`);
  console.log(`seed.sql applied. System-layer templates now present (${r.rows.length}):`);
  for (const row of r.rows) console.log(`  ${row.code} — ${row.title}`);
} finally {
  await db.end();
}
