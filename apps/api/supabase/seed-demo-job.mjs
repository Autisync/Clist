// FieldReady — one demo client + job for the real "antenas-rex" tenant
// (provision-tenant.mjs). §6 Step 5.
//
// Purely for manually exercising the Supabase-native pages in a real
// browser (there's no UI yet to create a client/job from scratch against
// Supabase directly — quotes/create-job aren't cut over to this app's UI
// yet either). Not a test fixture cleaned up after itself like the
// verify-*.mjs scripts — this is meant to persist as a real, visible demo
// record, same spirit as seed.sql's own reference data, just tenant-scoped
// instead of system-layer.
//
// Refuses to create a duplicate if a job with this code already exists for
// the tenant — safe to re-run.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/seed-demo-job.mjs

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
if (!projectRef || !dbPassword) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD.');
  process.exit(1);
}

const TENANT_SLUG = 'antenas-rex';
const JOB_CODE = 'JOB-1042';

const db = new Client(pgClientConfig(projectRef, dbPassword));
await db.connect();

try {
  const tenant = await db.query(`select id from tenant where slug = $1`, [TENANT_SLUG]);
  if (tenant.rows.length === 0) {
    console.error(`No tenant with slug "${TENANT_SLUG}" — run provision-tenant.mjs first.`);
    process.exit(1);
  }
  const tenantId = tenant.rows[0].id;

  const existing = await db.query(`select id from job where tenant_id = $1 and code = $2`, [tenantId, JOB_CODE]);
  if (existing.rows.length > 0) {
    console.log(`Job ${JOB_CODE} already exists (id ${existing.rows[0].id}) — nothing to do.`);
    process.exit(0);
  }

  const client = await db.query(
    `insert into client (tenant_id, name, address, phone) values ($1, $2, $3, $4) returning id`,
    [tenantId, 'Condomínio Jardim do Sol', 'Rua das Flores 42, Lisboa', '912345678']
  );
  const clientId = client.rows[0].id;

  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, address, scheduled_at, quoted_hours, quoted_materials, status)
     values ($1, $2, $3, $4, $4, $5, now() + interval '2 days', 3.5, 210.0, 'ready_check') returning id`,
    [tenantId, clientId, JOB_CODE, 'TDT — instalação nova', 'Rua das Flores 42, 3º andar, Lisboa']
  );
  const jobId = job.rows[0].id;

  await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values
      ($1, $2, 'material', 'Antena UHF exterior', 'job', true, 'ok'),
      ($1, $2, 'equipment', 'Medidor de campo', 'job', true, 'missing')`,
    [tenantId, jobId]
  );

  console.log(`Created client "Condomínio Jardim do Sol" (${clientId}) and job ${JOB_CODE} (${jobId}).`);
} finally {
  await db.end();
}
