// FieldReady — §6 Step 4: the remaining sync-mutation RPCs + rpc_dispatch_job.
// 08-supabase-native-migration.md §4/§6 step 4.
//
// One evolving fixture (jobA in a non-basic tenant, jobB in a basic tenant)
// walked through a sequence of real RPC calls — deliberately, so
// rpc_dispatch_job's four gate conditions can each be triggered, fixed via
// the OTHER new RPCs (rpc_checklist_item_update from Step 3,
// rpc_van_audit_record here), and re-checked, the same way a real technician
// session would clear a readiness gate one item at a time, rather than five
// independent single-purpose fixtures that never touch each other.
//
// Assumes schema.sql, holidays.sql, and rpc.sql are already applied.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-step4-rpc.mjs

import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createReporter, pgClientConfig, createAuthAdmin } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error(
    'Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.\n' +
    'Run as: cd apps/api && node --env-file=.env supabase/verify-step4-rpc.mjs'
  );
  process.exit(1);
}

const supabaseUrl = `https://${projectRef}.supabase.co`;
const authApiBase = `${supabaseUrl}/auth/v1`;

const reporter = createReporter();
const { ok, fail } = reporter;
const db = new Client(pgClientConfig(projectRef, dbPassword));

const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser, sweepTestAuthUsers } = createAuthAdmin({
  authApiBase, serviceRoleKey, createdAuthUserIds,
});

function anonClient() {
  return createClient(supabaseUrl, anonKey);
}
async function signInAs(email, password) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}
async function techEmailFor(authId) {
  const res = await fetch(`${authApiBase}/admin/users/${authId}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  return (await res.json()).email;
}

const createdTenantIds = [];

// Order matters here in a way it didn't in Step 3's cleanup: this fixture
// stamps job.ited_classification_by with a real app_user.id (fix 3/4 above,
// simulating an office review), and that FK has no ON DELETE action
// (default RESTRICT). Deleting an office auth user cascades to delete their
// app_user row (app_user.auth_user_id is ON DELETE CASCADE) — but that
// cascade itself gets blocked if `job` still references that app_user row,
// which surfaces as the auth-user DELETE call failing outright (caught the
// first time this ran: "deleteAuthUser returned false", swallowed as a mere
// warning rather than investigated). Fixed by deleting every job-referencing
// table, then job itself, BEFORE attempting any auth-user deletion —
// technician_device is deleted before auth users for the same underlying
// reason Step 3's cleanup already established (its own auth_user_id FK has
// no cascade either).
async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  if (createdTenantIds.length > 0) {
    await step('delete applied_mutation', () => db.query(`delete from applied_mutation where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete compliance_deadline', () => db.query(`delete from compliance_deadline where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_closeout', () => db.query(`delete from job_closeout where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_test_result', () => db.query(`delete from job_test_result where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_execution_step_completion', () => db.query(`delete from job_execution_step_completion where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_checklist_item', () => db.query(`delete from job_checklist_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job', () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete van_audit', () => db.query(`delete from van_audit where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete equipment', () => db.query(`delete from equipment where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete technician_device', () => db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id).then((ok2) => { if (!ok2) throw new Error('deleteAuthUser returned false'); }));
  }
  if (createdTenantIds.length > 0) {
    await step('delete client', () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete remaining app_user rows', () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete tenant', () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

// ---- 0. Preconditions ------------------------------------------------------

try {
  const r = await db.query(`
    select
      to_regproc('public.fn_current_app_user_id') is not null as app_user_id_fn,
      to_regproc('public.fn_add_working_days') is not null as holidays_fn,
      to_regprocedure('public.rpc_dispatch_job(uuid)') is not null as dispatch_fn
  `);
  if (!r.rows[0].app_user_id_fn || !r.rows[0].holidays_fn || !r.rows[0].dispatch_fn) {
    console.error(
      '\nRequired functions not found — run, in order:\n' +
      '  npm run verify:schema-supabase\n  npm run verify:holidays-supabase\n' +
      'then apply rpc.sql (verify:step3-supabase applies it automatically if missing).'
    );
    await db.end();
    process.exit(1);
  }
  ok('schema.sql, holidays.sql, and rpc.sql are all applied');
} catch (err) {
  fail('preconditions', err);
  await db.end();
  process.exit(1);
}

console.log('Sweeping any leftover test auth users from prior/interrupted runs ...');
try {
  const { found, deleted } = await sweepTestAuthUsers();
  ok(`prior-run auth users swept (${deleted}/${found} deleted)`);
} catch (err) {
  fail('auth user sweep', err);
}

// ---- fixtures ---------------------------------------------------------------

const tenantA = crypto.randomUUID(); // 'ited_ready' — exercises the ited_classification gate + termo deadline
const tenantB = crypto.randomUUID(); // 'basic' — skips both
const marker = crypto.randomUUID().slice(0, 8);

let techASession, techBSession, officeASession;
let jobAId, jobBId, jobCId, itemA1Id, itemAVanId, equipmentId, officeAAppUserId, officeAEmail, officeAPassword;

try {
  await db.query(
    `insert into tenant (id, name, slug, compliance_profile) values
       ($1, 'Antenas Rex, Lda', $2, 'ited_ready'),
       ($3, 'Outro Instalador, Lda', $4, 'basic')`,
    [tenantA, `antenas-rex-s4-${marker}`, tenantB, `outro-instalador-s4-${marker}`]
  );
  createdTenantIds.push(tenantA, tenantB);

  officeAAppUserId = crypto.randomUUID();
  officeAEmail = `office-s4-a-${marker}@device.fieldready.internal`;
  officeAPassword = 'Verify-S4-Test-Passw0rd!';
  const officeAAuthId = await createAuthUser(officeAEmail, officeAPassword);
  await db.query(
    `insert into app_user (id, auth_user_id, tenant_id, role, full_name, email) values ($1, $2, $3, 'owner', 'Office A', $4)`,
    [officeAAppUserId, officeAAuthId, tenantA, officeAEmail]
  );

  const techAAppUserId = crypto.randomUUID();
  await db.query(`insert into app_user (id, tenant_id, role, full_name) values ($1, $2, 'technician', 'Tech A')`, [techAAppUserId, tenantA]);
  const techAAuthId = await createAuthUser(`device-s4-a-${marker}@device.fieldready.internal`, '1234-device-secret');
  await db.query(
    `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by) values ($1, $2, 'Device A', $3, $4)`,
    [tenantA, techAAppUserId, techAAuthId, officeAAppUserId]
  );

  const officeBAppUserId = crypto.randomUUID();
  const officeBAuthId = await createAuthUser(`office-s4-b-${marker}@device.fieldready.internal`, 'Verify-S4-Test-Passw0rd!');
  await db.query(
    `insert into app_user (id, auth_user_id, tenant_id, role, full_name, email) values ($1, $2, $3, 'owner', 'Office B', $4)`,
    [officeBAppUserId, officeBAuthId, tenantB, `office-s4-b-${marker}@device.fieldready.internal`]
  );
  const techBAppUserId = crypto.randomUUID();
  await db.query(`insert into app_user (id, tenant_id, role, full_name) values ($1, $2, 'technician', 'Tech B')`, [techBAppUserId, tenantB]);
  const techBAuthId = await createAuthUser(`device-s4-b-${marker}@device.fieldready.internal`, '1234-device-secret');
  await db.query(
    `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by) values ($1, $2, 'Device B', $3, $4)`,
    [tenantB, techBAppUserId, techBAuthId, officeBAppUserId]
  );

  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantA]);
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantB]);

  const equipment = await db.query(
    `insert into equipment (tenant_id, kind, calibration_expires_on) values ($1, 'Medidor de campo', $2) returning id`,
    [tenantA, '2020-01-01'] // already expired
  );
  equipmentId = equipment.rows[0].id;

  const testProtocolSnapshot = JSON.stringify({
    network_type: 'SMATV',
    tests: [
      { id: 't1', label: 'Nível', unit: 'dBµV', dir: 'range', min: 10, max: 20, instrument_id: equipmentId },
      { id: 't2', label: 'C/N', unit: 'dB', dir: 'min', min: 5 },
      { id: 't3', label: 'MER', unit: '%', dir: 'max', max: 100 },
      { id: 't4', label: 'Certificação externa', dir: 'external_pass_fail' },
    ],
  });

  const jobA = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, test_protocol_snapshot)
     values ($1, $2, $3, 'Teste Step 4 A', 'TDT novo', 3, 100, $4::jsonb) returning id`,
    [tenantA, clientA.rows[0].id, `JOB-S4A-${marker}`, testProtocolSnapshot]
  );
  jobAId = jobA.rows[0].id;

  const item1 = await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values ($1, $2, 'material', 'Antena', 'job', true, 'missing') returning id`,
    [tenantA, jobAId]
  );
  itemA1Id = item1.rows[0].id;
  const itemVan = await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values ($1, $2, 'equipment', 'Kit da carrinha', 'van', true, 'missing') returning id`,
    [tenantA, jobAId]
  );
  itemAVanId = itemVan.rows[0].id;

  const jobB = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
     values ($1, $2, $3, 'Teste Step 4 B', 'TDT novo', 2, 50) returning id`,
    [tenantB, clientB.rows[0].id, `JOB-S4B-${marker}`]
  );
  jobBId = jobB.rows[0].id;
  await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values ($1, $2, 'material', 'Antena', 'job', true, 'ok')`,
    [tenantB, jobBId]
  );

  // jobC: every dispatch-gate condition pre-satisfied, dedicated to the
  // genuine-concurrency tests below (security review, high — the
  // sequential resubmission/replay tests above don't exercise real
  // in-flight overlap, which is exactly the race the FOR UPDATE fix in
  // rpc_dispatch_job/rpc_closeout_submit targets).
  const jobC = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, ited_classification_by)
     values ($1, $2, $3, 'Teste Step 4 C (concorrência)', 'TDT novo', 2, 50, $4) returning id`,
    [tenantA, clientA.rows[0].id, `JOB-S4C-${marker}`, officeAAppUserId]
  );
  jobCId = jobC.rows[0].id;
  await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values ($1, $2, 'material', 'Antena', 'job', true, 'ok')`,
    [tenantA, jobCId]
  );

  techASession = await signInAs(await techEmailFor(techAAuthId), '1234-device-secret');
  techBSession = await signInAs(await techEmailFor(techBAuthId), '1234-device-secret');
  officeASession = await signInAs(officeAEmail, officeAPassword);

  ok('fixtures created: 2 tenants (ited_ready + basic), 3 jobs, expired-calibration equipment, real test_protocol_snapshot');
} catch (err) {
  fail('fixture setup', err);
  console.log('\nFixture setup failed — cleaning up whatever was created, then stopping.');
  await cleanupFixtures();
  await db.end();
  process.exit(1);
}

// ---- 1. rpc_execution_step_complete ---------------------------------------

try {
  const cmId = crypto.randomUUID();
  const { data, error } = await techASession.rpc('rpc_execution_step_complete', {
    p_client_mutation_id: cmId, p_job_id: jobAId, p_step: 0,
  });
  if (error) throw error;
  if (data.status === 'applied' && data.step_order === 0) {
    ok('execution_step.complete: step 0 applies via the RPC');
  } else {
    fail('execution_step.complete apply', new Error(JSON.stringify(data)));
  }

  const row = await db.query(`select completed_by from job_execution_step_completion where job_id = $1 and step_order = 0`, [jobAId]);
  const techAAppUserIdRow = await db.query(
    `select au.id from technician_device td join app_user au on au.id = td.user_id where td.tenant_id = $1 and au.role = 'technician'`,
    [tenantA]
  );
  if (row.rows[0]?.completed_by === techAAppUserIdRow.rows[0]?.id) {
    ok('execution_step.complete: completed_by is stamped with the caller\'s real app_user.id (fn_current_app_user_id)');
  } else {
    fail('execution_step.complete completed_by', new Error(`expected ${techAAppUserIdRow.rows[0]?.id}, got ${row.rows[0]?.completed_by}`));
  }

  const replay = await techASession.rpc('rpc_execution_step_complete', { p_client_mutation_id: cmId, p_job_id: jobAId, p_step: 0 });
  if (replay.data.status === 'already_applied') {
    ok('execution_step.complete: replaying the same client_mutation_id returns already_applied');
  } else {
    fail('execution_step.complete replay', new Error(JSON.stringify(replay.data)));
  }

  const newStep = await techASession.rpc('rpc_execution_step_complete', { p_client_mutation_id: crypto.randomUUID(), p_job_id: jobAId, p_step: 1 });
  if (newStep.data.status === 'applied' && newStep.data.step_order === 1) {
    ok('execution_step.complete: a genuinely new step (1) still applies after the replay');
  } else {
    fail('execution_step.complete new step', new Error(JSON.stringify(newStep.data)));
  }
} catch (err) {
  fail('execution_step.complete', err);
}

// ---- 1b. fn_current_app_user_id()'s OFFICE branch — security review
// (high, confirmed): every RPC call above went through a technician
// session, so the office half of fn_current_app_user_id() (schema.sql)
// had zero coverage across every verify script in this folder. Calling the
// same RPC as an office user and confirming completed_by resolves to the
// OFFICE app_user.id (not the technician's) is what actually exercises the
// `app_user.auth_user_id = auth.uid()` branch, not just the
// technician_device join branch checks 1 already covers.

try {
  const { data, error } = await officeASession.rpc('rpc_execution_step_complete', {
    p_client_mutation_id: crypto.randomUUID(), p_job_id: jobAId, p_step: 2,
  });
  if (error) throw error;
  if (data.status === 'applied' && data.completed_by === officeAAppUserId) {
    ok("execution_step.complete: called as an OFFICE session resolves completed_by to the office app_user.id (fn_current_app_user_id's office branch, previously untested)");
  } else {
    fail('execution_step.complete office branch', new Error(`expected completed_by=${officeAAppUserId}, got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('execution_step.complete office branch', err);
}

// ---- 2. rpc_test_result_record — every evalTest dir branch -----------------

try {
  const cases = [
    { test_code: 't1', measured_value: '15', expected: 'pass' },  // range 10-20
    { test_code: 't2', measured_value: '3', expected: 'fail' },   // min 5
    { test_code: 't3', measured_value: '50', expected: 'pass' },  // max 100
    { test_code: 't4', measured_value: 'PASS', expected: 'pass' }, // external_pass_fail, case-insensitive
    { test_code: 'unknown_test', measured_value: '999', expected: 'na' }, // no match in snapshot
  ];
  let allOk = true;
  for (const c of cases) {
    const { data, error } = await techASession.rpc('rpc_test_result_record', {
      p_client_mutation_id: crypto.randomUUID(),
      p_job_id: jobAId,
      p_network_type: 'SMATV',
      p_location_label: 'Tomada — Sala',
      p_test_code: c.test_code,
      p_measured_value: c.measured_value,
      p_unit: null,
      p_limit_ref: null,
      p_capture_source: 'manual',
      p_raw_capture_file: null,
      p_instrument_id: null,
    });
    if (error || data.status !== 'applied' || data.outcome !== c.expected) {
      allOk = false;
      fail(`test_result.record (${c.test_code})`, new Error(`expected outcome=${c.expected}, got ${JSON.stringify(data ?? error)}`));
    }
  }
  if (allOk) ok('test_result.record: range/min/max/external_pass_fail/no-match(na) all evaluate correctly via fn_eval_test');
} catch (err) {
  fail('test_result.record', err);
}

try {
  const cmId = crypto.randomUUID();
  const first = await techASession.rpc('rpc_test_result_record', {
    p_client_mutation_id: cmId, p_job_id: jobAId, p_network_type: 'SMATV', p_location_label: 'Replay test',
    p_test_code: 't1', p_measured_value: '15', p_unit: null, p_limit_ref: null,
    p_capture_source: 'manual', p_raw_capture_file: null, p_instrument_id: null,
  });
  const replay = await techASession.rpc('rpc_test_result_record', {
    p_client_mutation_id: cmId, p_job_id: jobAId, p_network_type: 'SMATV', p_location_label: 'Replay test',
    p_test_code: 't1', p_measured_value: '15', p_unit: null, p_limit_ref: null,
    p_capture_source: 'manual', p_raw_capture_file: null, p_instrument_id: null,
  });
  const count = await db.query(`select count(*)::int as n from job_test_result where tenant_id = $1 and location_label = 'Replay test'`, [tenantA]);
  if (replay.data.status === 'already_applied' && count.rows[0].n === 1) {
    ok('test_result.record: replay returns already_applied and does not double-insert');
  } else {
    fail('test_result.record replay', new Error(`replay=${JSON.stringify(replay.data)}, row count=${count.rows[0].n}`));
  }
} catch (err) {
  fail('test_result.record replay', err);
}

// ---- 3. rpc_dispatch_job: initial call — all 4 conditions blocking at once

try {
  const { data, error } = await techASession.rpc('rpc_dispatch_job', { p_job_id: jobAId });
  if (error) throw error;
  const kinds = new Set((data.blocking ?? []).map((b) => b.kind));
  const expectedKinds = ['checklist_item', 'van_audit_stale', 'calibration_expired', 'ited_classification_unreviewed'];
  const allPresent = expectedKinds.every((k) => kinds.has(k));
  if (data.kind === 'not_ready' && allPresent) {
    ok(`dispatch: initial attempt blocked by all 4 conditions at once (${[...kinds].join(', ')})`);
  } else {
    fail('dispatch initial not_ready', new Error(`expected all 4 kinds, got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('dispatch initial not_ready', err);
}

// ---- 4. Fix conditions one at a time via the OTHER real RPCs --------------

try {
  const { data } = await techASession.rpc('rpc_checklist_item_update', {
    p_client_mutation_id: crypto.randomUUID(), p_job_id: jobAId, p_item_id: itemA1Id, p_status: 'ok',
  });
  if (data.status === 'applied') ok('dispatch fix 1/4: rpc_checklist_item_update clears the checklist_item condition');
  else fail('dispatch fix 1 (checklist)', new Error(JSON.stringify(data)));
} catch (err) { fail('dispatch fix 1 (checklist)', err); }

try {
  const vanAuditCmId = crypto.randomUUID();
  const { data } = await techASession.rpc('rpc_van_audit_record', {
    p_client_mutation_id: vanAuditCmId, p_van_label: 'Van 1', p_issues: [],
  });
  if (data.status === 'applied') ok('dispatch fix 2/4: rpc_van_audit_record clears the van_audit_stale condition');
  else fail('dispatch fix 2 (van audit)', new Error(JSON.stringify(data)));

  // Security review (high, confirmed): this was the only sync-mutation RPC
  // of the five with no idempotent-replay test anywhere in this suite —
  // every other one (checklist/test_result/execution_step/closeout) gets
  // this exact check.
  const replay = await techASession.rpc('rpc_van_audit_record', {
    p_client_mutation_id: vanAuditCmId, p_van_label: 'Van 1', p_issues: [],
  });
  const count = await db.query(`select count(*)::int as n from van_audit where tenant_id = $1`, [tenantA]);
  if (replay.data.status === 'already_applied' && count.rows[0].n === 1) {
    ok('van_audit.record: replaying the same client_mutation_id returns already_applied and does not double-insert');
  } else {
    fail('van_audit.record replay', new Error(`replay=${JSON.stringify(replay.data)}, row count=${count.rows[0].n}`));
  }
} catch (err) { fail('dispatch fix 2 (van audit)', err); }

try {
  const r = await techASession.rpc('rpc_dispatch_job', { p_job_id: jobAId });
  const kinds = new Set((r.data.blocking ?? []).map((b) => b.kind));
  if (r.data.kind === 'not_ready' && kinds.has('calibration_expired') && kinds.has('ited_classification_unreviewed') && !kinds.has('checklist_item') && !kinds.has('van_audit_stale')) {
    ok('dispatch: after fixes 1+2, exactly the remaining 2 conditions (calibration_expired, ited_classification_unreviewed) still block');
  } else {
    fail('dispatch partial-fix state', new Error(JSON.stringify(r.data)));
  }
} catch (err) { fail('dispatch partial-fix state', err); }

try {
  // ited_classification review is an office-only action in the real system
  // (never technician-set, CLAUDE.md) — done here via a direct superuser
  // write, matching how the office web UI's own route would do it (a
  // PATCH /jobs/:id equivalent RPC is out of scope for this slice).
  await db.query(`update job set ited_classification_by = $1 where id = $2`, [officeAAppUserId, jobAId]);
  await db.query(`update equipment set calibration_expires_on = $1 where id = $2`, ['2099-01-01', equipmentId]);
  ok('dispatch fix 3/4 + 4/4: ited_classification reviewed (office action) and calibration renewed');
} catch (err) { fail('dispatch fix 3+4', err); }

// ---- 5. rpc_dispatch_job: all conditions clear — succeeds and flips status

try {
  const { data, error } = await techASession.rpc('rpc_dispatch_job', { p_job_id: jobAId });
  if (error) throw error;
  if (data.kind === 'ok') {
    ok('dispatch: succeeds once all 4 conditions are cleared (kind=ok)');
  } else {
    fail('dispatch success', new Error(JSON.stringify(data)));
  }

  // Security review (medium, confirmed): the success response's whole
  // documented point is returning the three frozen snapshots (matching
  // Phase 2's "dispatch succeeding with all three snapshots present" exit
  // criterion) — checking only kind==='ok' would pass even if the
  // RETURNING clause silently came back empty.
  if (data.kind === 'ok' && data.test_protocol_snapshot && data.test_protocol_snapshot.network_type === 'SMATV') {
    ok('dispatch: the response itself carries the real test_protocol_snapshot (not just kind=ok with empty snapshots)');
  } else {
    fail('dispatch response snapshot fields', new Error(`expected test_protocol_snapshot.network_type=SMATV, got ${JSON.stringify(data)}`));
  }

  const row = await db.query(`select status from job where id = $1`, [jobAId]);
  if (row.rows[0].status === 'dispatched') {
    ok('dispatch: job.status really flipped to dispatched in the database');
  } else {
    fail('dispatch status flip (db confirmation)', new Error(`expected dispatched, got ${row.rows[0].status}`));
  }
} catch (err) {
  fail('dispatch success', err);
}

// ---- 6. rpc_dispatch_job: re-dispatch is rejected as wrong_status ---------

try {
  const { data, error } = await techASession.rpc('rpc_dispatch_job', { p_job_id: jobAId });
  if (error) throw error;
  if (data.kind === 'wrong_status' && data.status === 'dispatched') {
    ok('dispatch: re-dispatching an already-dispatched job is rejected (wrong_status), not silently re-run');
  } else {
    fail('dispatch wrong_status', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('dispatch wrong_status', err);
}

// ---- 7. rpc_dispatch_job: basic-tenant happy path, no ited gate ----------

try {
  const { data, error } = await techBSession.rpc('rpc_dispatch_job', { p_job_id: jobBId });
  if (error) throw error;
  if (data.kind === 'ok') {
    ok("dispatch: basic-profile tenant's job dispatches with an unreviewed ited_classification (condition (d) correctly skipped for basic)");
  } else {
    fail('dispatch basic tenant', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('dispatch basic tenant', err);
}

// ---- 8. rpc_dispatch_job: cross-tenant target is not_found, not a leak ----

try {
  const { data, error } = await techBSession.rpc('rpc_dispatch_job', { p_job_id: jobAId });
  if (error) throw error;
  if (data.kind === 'not_found') {
    ok("dispatch: tenant B's technician targeting tenant A's job gets not_found (RLS makes it invisible, not a leak)");
  } else {
    fail('dispatch cross-tenant', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('dispatch cross-tenant', err);
}

// ---- 9. rpc_closeout_submit: non-basic tenant — termo deadline inserted --

try {
  const cmId = crypto.randomUUID();
  const { data, error } = await techASession.rpc('rpc_closeout_submit', {
    p_client_mutation_id: cmId, p_job_id: jobAId, p_first_time_fix: true,
    p_technician_voice_note_file: null, p_technician_note_transcript: 'Tudo ok.', p_client_signature_file: null,
  });
  if (error) throw error;
  if (data.status !== 'applied') fail('closeout first apply', new Error(JSON.stringify(data)));

  const job = await db.query(`select status, completed_at from job where id = $1`, [jobAId]);
  if (job.rows[0].status === 'closed' && job.rows[0].completed_at) {
    ok('closeout.submit: job.status flips to closed and completed_at is set on first submission');
  } else {
    fail('closeout job status/completed_at', new Error(JSON.stringify(job.rows[0])));
  }

  const expectedDueOn = await db.query(
    `select fn_add_working_days(($1::timestamptz at time zone 'utc')::date, 10)::text as due_on`,
    [job.rows[0].completed_at]
  );
  const deadline = await db.query(`select due_on::text as due_on from compliance_deadline where job_id = $1 and kind = 'termo'`, [jobAId]);
  if (deadline.rows.length === 1 && deadline.rows[0].due_on === expectedDueOn.rows[0].due_on) {
    ok(`closeout.submit: exactly one termo compliance_deadline inserted, due_on=${deadline.rows[0].due_on} matches fn_add_working_days independently`);
  } else {
    fail('closeout termo deadline', new Error(`expected 1 row due_on=${expectedDueOn.rows[0].due_on}, got ${JSON.stringify(deadline.rows)}`));
  }

  const replay = await techASession.rpc('rpc_closeout_submit', {
    p_client_mutation_id: cmId, p_job_id: jobAId, p_first_time_fix: true,
    p_technician_voice_note_file: null, p_technician_note_transcript: 'Tudo ok.', p_client_signature_file: null,
  });
  const deadlineCountAfterReplay = await db.query(`select count(*)::int as n from compliance_deadline where job_id = $1 and kind = 'termo'`, [jobAId]);
  if (replay.data.status === 'already_applied' && deadlineCountAfterReplay.rows[0].n === 1) {
    ok('closeout.submit: replay returns already_applied and does not insert a second deadline');
  } else {
    fail('closeout replay', new Error(`replay=${JSON.stringify(replay.data)}, deadline count=${deadlineCountAfterReplay.rows[0].n}`));
  }

  // A genuine resubmission (different client_mutation_id, e.g. a corrected
  // voice note before dispatch of anything else) upserts job_closeout but
  // must NOT insert a second deadline — completed_at was already non-null.
  const resubmit = await techASession.rpc('rpc_closeout_submit', {
    p_client_mutation_id: crypto.randomUUID(), p_job_id: jobAId, p_first_time_fix: false,
    p_technician_voice_note_file: null, p_technician_note_transcript: 'Correção: houve retrabalho.', p_client_signature_file: null,
  });
  const closeoutRow = await db.query(`select first_time_fix from job_closeout where job_id = $1`, [jobAId]);
  const deadlineCountAfterResubmit = await db.query(`select count(*)::int as n from compliance_deadline where job_id = $1 and kind = 'termo'`, [jobAId]);
  if (resubmit.data.status === 'applied' && closeoutRow.rows[0].first_time_fix === false && deadlineCountAfterResubmit.rows[0].n === 1) {
    ok('closeout.submit: a genuine resubmission (new client_mutation_id) upserts job_closeout but inserts no second deadline');
  } else {
    fail('closeout resubmission', new Error(`resubmit=${JSON.stringify(resubmit.data)}, first_time_fix=${closeoutRow.rows[0].first_time_fix}, deadline count=${deadlineCountAfterResubmit.rows[0].n}`));
  }
} catch (err) {
  fail('closeout.submit (non-basic tenant)', err);
}

// ---- 10. rpc_closeout_submit: basic tenant — no deadline inserted at all --

try {
  const { data, error } = await techBSession.rpc('rpc_closeout_submit', {
    p_client_mutation_id: crypto.randomUUID(), p_job_id: jobBId, p_first_time_fix: true,
    p_technician_voice_note_file: null, p_technician_note_transcript: 'Tudo ok.', p_client_signature_file: null,
  });
  if (error) throw error;
  const deadlines = await db.query(`select count(*)::int as n from compliance_deadline where job_id = $1`, [jobBId]);
  if (data.status === 'applied' && deadlines.rows[0].n === 0) {
    ok('closeout.submit: a basic-profile tenant\'s job closes with zero compliance_deadline rows (gate correctly skipped)');
  } else {
    fail('closeout basic tenant', new Error(`status=${data.status}, deadline count=${deadlines.rows[0].n}`));
  }
} catch (err) {
  fail('closeout.submit (basic tenant)', err);
}

// ---- 11. rpc_closeout_submit: job_not_found is rejected, not an error -----

try {
  const { data, error } = await techASession.rpc('rpc_closeout_submit', {
    p_client_mutation_id: crypto.randomUUID(), p_job_id: crypto.randomUUID(), p_first_time_fix: true,
    p_technician_voice_note_file: null, p_technician_note_transcript: 'x', p_client_signature_file: null,
  });
  if (error) throw error;
  if (data.status === 'rejected' && data.reason === 'job_not_found') {
    ok('closeout.submit: a nonexistent job_id is rejected as job_not_found');
  } else {
    fail('closeout job_not_found', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('closeout job_not_found', err);
}

// ---- 12. GENUINE concurrency, not just sequential replay — security review
// (high, confirmed): every replay/resubmission test above awaits each RPC
// call to finish before issuing the next, which never exercises real
// in-flight overlap. jobC has every dispatch-gate condition pre-satisfied
// specifically so two concurrent calls both reach the race window. Fired
// via Promise.all (two independent Supabase client instances, matching two
// real concurrent devices/tabs, not two awaited-in-sequence calls dressed
// up to look concurrent).

try {
  const [d1, d2] = await Promise.all([
    techASession.rpc('rpc_dispatch_job', { p_job_id: jobCId }),
    officeASession.rpc('rpc_dispatch_job', { p_job_id: jobCId }),
  ]);
  const kinds = [d1.data?.kind, d2.data?.kind].sort();
  if (JSON.stringify(kinds) === JSON.stringify(['ok', 'wrong_status'])) {
    ok('dispatch CONCURRENCY: two genuinely simultaneous dispatch calls on the same job — exactly one ok, one wrong_status (FOR UPDATE serializes correctly, TOCTOU race actually closed)');
  } else {
    fail('dispatch concurrency', new Error(`expected exactly one [ok, wrong_status], got ${JSON.stringify([d1.data, d2.data])}`));
  }
} catch (err) {
  fail('dispatch concurrency', err);
}

try {
  const cmA = crypto.randomUUID();
  const cmB = crypto.randomUUID();
  const [c1, c2] = await Promise.all([
    techASession.rpc('rpc_closeout_submit', {
      p_client_mutation_id: cmA, p_job_id: jobCId, p_first_time_fix: true,
      p_technician_voice_note_file: null, p_technician_note_transcript: 'Concurrent A', p_client_signature_file: null,
    }),
    officeASession.rpc('rpc_closeout_submit', {
      p_client_mutation_id: cmB, p_job_id: jobCId, p_first_time_fix: false,
      p_technician_voice_note_file: null, p_technician_note_transcript: 'Concurrent B', p_client_signature_file: null,
    }),
  ]);
  if (c1.error) throw c1.error;
  if (c2.error) throw c2.error;

  const deadlines = await db.query(`select count(*)::int as n from compliance_deadline where job_id = $1 and kind = 'termo'`, [jobCId]);
  if (c1.data.status === 'applied' && c2.data.status === 'applied' && deadlines.rows[0].n === 1) {
    ok('closeout CONCURRENCY: two genuinely simultaneous closeout submissions on the same job — both applied, but exactly ONE termo compliance_deadline row (FOR UPDATE closes the double-insert race)');
  } else {
    fail('closeout concurrency', new Error(`c1=${JSON.stringify(c1.data)}, c2=${JSON.stringify(c2.data)}, deadline count=${deadlines.rows[0].n}`));
  }
} catch (err) {
  fail('closeout concurrency', err);
}

// ---- cleanup ---------------------------------------------------------------

console.log(`\nCleaning up ${createdAuthUserIds.length} test auth user(s) and fixture rows ...`);
await cleanupFixtures();

await db.end();

console.log('\n' + (reporter.failures === 0
  ? `All checks passed.`
  : `${reporter.failures} check(s) failed — see FAIL lines above.`));
process.exit(reporter.failures === 0 ? 0 : 1);
