// FieldReady — seed verification harness.
//
// Applies 03-schema.sql then seed.sql against a real in-process PostgreSQL
// (PGlite) and checks that the two seeded test_protocol template versions
// are genuinely active and genuinely verified — i.e. that seed.sql
// satisfies the ited_full compliance gate with real data rather than
// smuggling an unverified row past it. Companion to verify-schema.mjs.
//
// Usage:
//   npm install @electric-sql/pglite
//   node verify-seed.mjs [path-to-schema.sql] [path-to-seed.sql]

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const schemaPath = process.argv[2] ?? new URL('./03-schema.sql', import.meta.url).pathname;
const seedPath = process.argv[3] ?? new URL('./seed.sql', import.meta.url).pathname;
const schemaSql = readFileSync(schemaPath, 'utf8');
const seedSql = readFileSync(seedPath, 'utf8');

const db = new PGlite();
let failures = 0;

function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, err) { failures++; console.log(`  FAIL ${label} -> ${err.message ?? err}`); }

console.log(`Applying ${schemaPath} ...`);
try {
  await db.exec(schemaSql);
  ok('schema applied with no errors');
} catch (err) {
  fail('schema apply', err);
  console.log('\nSchema failed to apply — stopping.');
  process.exit(1);
}

console.log(`Applying ${seedPath} ...`);
try {
  await db.exec(seedSql);
  ok('seed applied with no errors (both test_protocol versions passed the activation gate)');
} catch (err) {
  fail('seed apply', err);
  console.log('\nSeed failed to apply — stopping, behavioural checks skipped.');
  process.exit(1);
}

// ---- both templates exist, active, and carry real verification -----------

try {
  const r = await db.query(`
    select t.code, tv.status, tv.verified_by is not null as has_verifier,
           tv.verified_source, tv.body->>'network_type' as network_type,
           jsonb_array_length(tv.body->'tests') as n_tests
    from template t
    join template_version tv on tv.template_id = t.id
    where t.code in ('coax_smatv_tt_tabela_6_12', 'fibra_optica_tabela_6_17')
    order by t.code;
  `);

  if (r.rows.length === 2) ok('both seeded test_protocol templates found');
  else fail('seeded templates present', new Error(`expected 2, got ${r.rows.length}`));

  for (const row of r.rows) {
    const label = row.code;
    if (row.status === 'active') ok(`${label}: status is active`);
    else fail(`${label}: status`, new Error(`expected active, got ${row.status}`));

    if (row.has_verifier) ok(`${label}: verified_by is set`);
    else fail(`${label}: verified_by`, new Error('verified_by is null — gate was bypassed'));

    if (row.verified_source && row.verified_source.includes('Manual ITED')) {
      ok(`${label}: verified_source cites Manual ITED`);
    } else {
      fail(`${label}: verified_source`, new Error(`unexpected value: ${row.verified_source}`));
    }

    if (row.n_tests > 0) ok(`${label}: body has ${row.n_tests} test parameter(s)`);
    else fail(`${label}: body.tests`, new Error('no tests in body'));
  }
} catch (err) {
  fail('seeded template checks', err);
}

// ---- the Tabela 6.12 values match the source exactly (spot check) --------

try {
  const r = await db.query(`
    select tv.body
    from template t
    join template_version tv on tv.template_id = t.id
    where t.code = 'coax_smatv_tt_tabela_6_12';
  `);
  const tests = r.rows[0].body.tests;
  const mer = tests.find(t => t.id === 'mer_hertziana');
  const nivel = tests.find(t => t.id === 'nivel_sinal_satelite');

  if (mer && Number(mer.min) === 19.5) ok('Tabela 6.12 spot check: MER hertziana limite inferior = 19,5 dB');
  else fail('Tabela 6.12 spot check (MER)', new Error(`got ${JSON.stringify(mer)}`));

  if (nivel && Number(nivel.min) === 47 && Number(nivel.max) === 77) {
    ok('Tabela 6.12 spot check: nível de sinal satélite = 47–77 dBµV');
  } else {
    fail('Tabela 6.12 spot check (nível de sinal)', new Error(`got ${JSON.stringify(nivel)}`));
  }
} catch (err) {
  fail('Tabela 6.12 spot check', err);
}

// ---- system templates (including these two) stay visible cross-tenant ----

try {
  const otherTenant = crypto.randomUUID();
  await db.exec(`insert into tenant (id, name, slug) values ('${otherTenant}', 'Unrelated Tenant', 'unrelated-tenant');`);
  const r = await db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.exec(`set local app.current_tenant_id = '${otherTenant}';`);
    return tx.query(`
      select count(*)::int as n from template
      where layer = 'system' and code in ('coax_smatv_tt_tabela_6_12', 'fibra_optica_tabela_6_17');
    `);
  });
  if (r.rows[0].n === 2) ok('RLS: both seeded system templates visible to an unrelated tenant');
  else fail('RLS visibility of seeded templates', new Error(`expected 2, got ${r.rows[0].n}`));
} catch (err) {
  fail('RLS visibility of seeded templates', err);
}

// ---- generic pass: EVERY active test_protocol template_version, whatever --
// its code is (06-phase3-compliance.md §2 asked for this to stop being a
// hardcoded two-name list once F11/F12 joined F13/F14 — this loop covers
// however many are seeded, present and future, without a third/fourth
// hardcoded block per template). Same three properties the block above
// already checks for F13/F14 specifically: genuinely verified (not a
// bypass), a real non-empty citation, and visible cross-tenant like any
// other system template.

try {
  const r = await db.query(`
    select t.id, t.code, tv.status, tv.verified_by is not null as has_verifier,
           tv.verified_source
    from template t
    join template_version tv on tv.template_id = t.id
    where t.kind = 'test_protocol' and tv.status = 'active'
    order by t.code;
  `);

  if (r.rows.length >= 2) ok(`generic pass: ${r.rows.length} active test_protocol template_version(s) found`);
  else fail('generic pass: active test_protocol count', new Error(`expected at least 2, got ${r.rows.length}`));

  const otherTenant2 = crypto.randomUUID();
  await db.exec(`insert into tenant (id, name, slug) values ('${otherTenant2}', 'Unrelated Tenant 2', 'unrelated-tenant-2');`);

  for (const row of r.rows) {
    const label = row.code;

    if (row.has_verifier) ok(`${label}: generic pass — verified_by is set`);
    else fail(`${label}: generic pass — verified_by`, new Error('verified_by is null — gate was bypassed'));

    if (row.verified_source && row.verified_source.trim().length > 0) {
      ok(`${label}: generic pass — verified_source is non-empty`);
    } else {
      fail(`${label}: generic pass — verified_source`, new Error(`unexpected value: ${JSON.stringify(row.verified_source)}`));
    }

    const vis = await db.transaction(async (tx) => {
      await tx.exec(`set local role fieldready_app;`);
      await tx.exec(`set local app.current_tenant_id = '${otherTenant2}';`);
      return tx.query(`select count(*)::int as n from template where id = '${row.id}' and layer = 'system';`);
    });
    if (vis.rows[0].n === 1) ok(`${label}: generic pass — visible cross-tenant`);
    else fail(`${label}: generic pass — cross-tenant visibility`, new Error(`expected 1, got ${vis.rows[0].n}`));
  }
} catch (err) {
  fail('generic pass over all active test_protocol templates', err);
}

// ---- summary ----------------------------------------------------------

console.log('\n' + (failures === 0
  ? `All checks passed.`
  : `${failures} check(s) failed — see FAIL lines above.`));
process.exit(failures === 0 ? 0 : 1);
