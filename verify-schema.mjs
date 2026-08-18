// FieldReady — schema verification harness.
//
// Runs 03-schema.sql against a real, in-process PostgreSQL (PGlite — Postgres
// compiled to WASM, no server/root/Docker required) and then exercises the
// parts of the schema that are load-bearing for the product's compliance
// story: RLS actually isolates tenants, the unverified-test-protocol gate
// actually blocks activation, and the REF/termo reconciliation trigger
// actually fires. A schema that merely *parses* is not enough for this
// domain — these checks are what make "verified" mean something.
//
// Usage:
//   npm install @electric-sql/pglite
//   node verify-schema.mjs [path-to-schema.sql]

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schemaPath = process.argv[2] ?? new URL('./03-schema.sql', import.meta.url).pathname;
const sql = readFileSync(schemaPath, 'utf8');

const db = new PGlite();
let failures = 0;

function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, err) { failures++; console.log(`  FAIL ${label} -> ${err.message ?? err}`); }

console.log(`Applying ${schemaPath} ...`);
try {
  await db.exec(sql);
  ok('schema applied with no errors');
} catch (err) {
  fail('schema apply', err);
  console.log('\nSchema failed to apply — stopping, behavioural checks skipped.');
  process.exit(1);
}

// ---- fixtures -------------------------------------------------------------

const tenantA = crypto.randomUUID();
const tenantB = crypto.randomUUID();
const userA = crypto.randomUUID();

await db.exec(`
  insert into tenant (id, name, slug) values
    ('${tenantA}', 'Antenas Rex, Lda', 'antenas-rex'),
    ('${tenantB}', 'Outro Instalador, Lda', 'outro-instalador');
  insert into app_user (id, tenant_id, role, full_name) values
    ('${userA}', '${tenantA}', 'owner', 'Rex');
`);

// ---- 1. RLS actually isolates tenants -------------------------------------

async function asTenant(tenantId, fn) {
  await db.exec(`set local role fieldready_app;`);
  await db.exec(`set local app.current_tenant_id = '${tenantId}';`);
  return fn();
}

try {
  await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.exec(`set local app.current_tenant_id = '${tenantA}';`);
    await tx.exec(`insert into client (tenant_id, name) values ('${tenantA}', 'Cliente A');`);
  });

  const seenAsB = await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.exec(`set local app.current_tenant_id = '${tenantB}';`);
    return tx.query(`select count(*)::int as n from client;`);
  });

  const seenAsA = await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.exec(`set local app.current_tenant_id = '${tenantA}';`);
    return tx.query(`select count(*)::int as n from client;`);
  });

  if (seenAsB.rows[0].n === 0 && seenAsA.rows[0].n === 1) {
    ok('RLS: tenant B sees 0 of tenant A\'s clients, tenant A sees its own 1');
  } else {
    fail('RLS tenant isolation', new Error(
      `expected [B:0, A:1], got [B:${seenAsB.rows[0].n}, A:${seenAsA.rows[0].n}]`));
  }
} catch (err) {
  fail('RLS tenant isolation', err);
}

// ---- 2. Unset tenant context fails safe (zero rows, not an error, not all rows) --

try {
  const r = await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    return tx.query(`select count(*)::int as n from client;`);
  });
  if (r.rows[0].n === 0) ok('RLS: no app.current_tenant_id set => zero rows (fail-safe)');
  else fail('RLS fail-safe', new Error(`expected 0 rows with no tenant set, got ${r.rows[0].n}`));
} catch (err) {
  fail('RLS fail-safe', err);
}

// ---- 3. System templates are visible to every tenant -----------------------

try {
  await db.exec(`
    insert into template (tenant_id, layer, kind, code, title) values
      (null, 'system', 'checklist', 'readiness_tdt_install', 'Readiness — TDT instalação nova');
  `);
  const r = await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.exec(`set local app.current_tenant_id = '${tenantB}';`);
    return tx.query(`select count(*)::int as n from template where layer = 'system';`);
  });
  if (r.rows[0].n === 1) ok('RLS: system template visible cross-tenant as intended');
  else fail('system template visibility', new Error(`expected 1, got ${r.rows[0].n}`));
} catch (err) {
  fail('system template visibility', err);
}

// ---- 4. Unverified test_protocol cannot be activated (ited-ref-mapping §7A.3) --

try {
  const tpl = await db.query(`
    insert into template (tenant_id, layer, kind, code, title)
    values ('${tenantA}', 'tenant', 'test_protocol', 'tdt_coax_v1', 'DVB-T2 coax test protocol')
    returning id;
  `);
  const templateId = tpl.rows[0].id;

  let blocked = false;
  try {
    await db.exec(`
      insert into template_version (template_id, version, status, body)
      values ('${templateId}', 1, 'active', '{"network_type":"CC","tests":[]}');
    `);
  } catch (err) {
    blocked = /unverified test_protocol/.test(err.message);
  }
  if (blocked) ok('gate: activating an unverified test_protocol is rejected');
  else fail('unverified test_protocol gate', new Error('activation was not blocked'));

  // now verify it properly and confirm activation succeeds
  await db.exec(`
    insert into template_version (template_id, version, status, body, verified_by, verified_source, verified_at)
    values ('${templateId}', 2, 'active', '{"network_type":"CC","tests":[]}',
            '${userA}', 'Manual ITED 4ª ed., p.168, Tabela 6.12', now());
  `);
  ok('gate: a verified test_protocol activates cleanly');
} catch (err) {
  fail('unverified test_protocol gate', err);
}

// ---- 5. REF <-> termo reconciliation trigger ------------------------------

try {
  const client = await db.query(`
    insert into client (tenant_id, name) values ('${tenantA}', 'Cliente REF') returning id;
  `);
  const job = await db.query(`
    insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
    values ('${tenantA}', '${client.rows[0].id}', 'JOB-9001', 'Teste REF', 'TDT novo', 3, 100)
    returning id;
  `);
  const jobId = job.rows[0].id;

  await db.exec(`
    insert into termo_responsabilidade (tenant_id, job_id, number, ref_id_field, issued_at)
    values ('${tenantA}', '${jobId}', 'TR-0001', 'REF-2026-0042', now());
  `);

  let mismatchBlocked = false;
  try {
    await db.exec(`
      insert into ref_document (tenant_id, job_id, ref_id)
      values ('${tenantA}', '${jobId}', 'REF-2026-DIFFERENT');
    `);
  } catch (err) {
    mismatchBlocked = /does not match/.test(err.message);
  }
  if (mismatchBlocked) ok('trigger: mismatched REF/termo id is rejected');
  else fail('REF/termo reconciliation', new Error('mismatch was not blocked'));

  await db.exec(`
    insert into ref_document (tenant_id, job_id, ref_id)
    values ('${tenantA}', '${jobId}', 'REF-2026-0042');
  `);
  ok('trigger: matching REF/termo id inserts cleanly');
} catch (err) {
  fail('REF/termo reconciliation', err);
}

// ---- 6. Dashboard views compute -------------------------------------------

try {
  const client = await db.query(`select id from client where tenant_id = '${tenantA}' limit 1;`);
  const job = await db.query(`
    insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, actual_hours)
    values ('${tenantA}', '${client.rows[0].id}', 'JOB-9002', 'Teste dashboard', 'TDT novo', 3.5, 214.6, 6.0)
    returning id;
  `);
  await db.exec(`
    insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status)
    values
      ('${tenantA}', '${job.rows[0].id}', 'material', 'Antena', 'job', true, 'ok'),
      ('${tenantA}', '${job.rows[0].id}', 'material', 'Fonte 24V', 'job', true, 'missing');
    insert into job_closeout (tenant_id, job_id, first_time_fix, closed_at)
    values ('${tenantA}', '${job.rows[0].id}', false, now());
  `);

  const readiness = await db.query(
    `select readiness_pct from v_job_readiness where job_id = '${job.rows[0].id}';`
  );
  const ffr = await db.query(`select ffr_pct from v_first_time_fix_rate where tenant_id = '${tenantA}';`);
  const variance = await db.query(
    `select avg_pct_variance from v_hours_variance where tenant_id = '${tenantA}' and job_type = 'TDT novo';`
  );

  if (Number(readiness.rows[0].readiness_pct) === 50.0) ok('view v_job_readiness computes 50.0%');
  else fail('v_job_readiness', new Error(`got ${JSON.stringify(readiness.rows)}`));

  if (ffr.rows.length === 1) ok('view v_first_time_fix_rate returns a row');
  else fail('v_first_time_fix_rate', new Error('no row returned'));

  if (variance.rows.length === 1) ok('view v_hours_variance returns a row');
  else fail('v_hours_variance', new Error('no row returned'));
} catch (err) {
  fail('dashboard views', err);
}

// ---- 7. Every table has RLS enabled (catches the exact bug this harness found
// twice while this schema was being written: a new table added without
// tenant_id, or added to a table list but not to the RLS loop) --------------

try {
  const r = await db.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'tenant'
      and c.relrowsecurity = false;
  `);
  if (r.rows.length === 0) {
    ok('every non-tenant table has row-level security enabled');
  } else {
    fail('RLS coverage', new Error(
      `tables missing RLS: ${r.rows.map(x => x.relname).join(', ')}`));
  }
} catch (err) {
  fail('RLS coverage', err);
}

// ---- summary ----------------------------------------------------------

console.log('\n' + (failures === 0
  ? `All checks passed.`
  : `${failures} check(s) failed — see FAIL lines above.`));
process.exit(failures === 0 ? 0 : 1);
