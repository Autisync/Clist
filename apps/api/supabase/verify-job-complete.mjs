// FieldReady — verifies the two new RPCs §6 Step 5's office job-detail
// cutover needed beyond §4's six named candidates: rpc_job_complete() and
// rpc_closeout_set_rework_cause() (rpc.sql's own comments on each explain
// why they qualify). Exercised through the real HTTP surface a browser
// would use — real Supabase Auth sign-in, real supabase.rpc() calls — same
// rigor as verify-step3-read-write.mjs / verify-create-job.mjs, not
// simulated GUCs.
//
// Deliberately does NOT re-derive the dispatch gate or fn_add_working_days'
// holiday-aware arithmetic — both already proven (verify-step4-rpc.mjs,
// verify-holidays.mjs). Fixture jobs are inserted directly at the
// precondition state rpc_job_complete actually cares about
// (status='dispatched', completed_at=null), matching this file's own job:
// prove what's NEW, not re-prove what's already proven.
//
// Assumes schema.sql, holidays.sql, and rpc.sql (including rpc_job_complete
// — apply with `npm run apply:rpc-supabase` if missing) are already applied.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-job-complete.mjs

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
    'Run as: cd apps/api && node --env-file=.env supabase/verify-job-complete.mjs'
  );
  process.exit(1);
}

const supabaseUrl = `https://${projectRef}.supabase.co`;
const authApiBase = `${supabaseUrl}/auth/v1`;

const reporter = createReporter();
const { ok, fail } = reporter;
const db = new Client(pgClientConfig(projectRef, dbPassword));

const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser } = createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds });

function anonClient() {
  return createClient(supabaseUrl, anonKey);
}

async function signInAs(email, password) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  if (!data.session) throw new Error(`sign-in for ${email} returned no session`);
  return client;
}

const createdTenantIds = [];

// app_user.auth_user_id references auth.users(id) with no ON DELETE action
// (schema.sql's own comment on this column) — deleting the auth user first
// while an app_user row still references it fails silently from this
// script's point of view (deleteAuthUser returns false, no thrown error),
// the exact gap verify-step3-read-write.mjs's own comment on this already
// documents. app_user (and everything else) must go first, auth users last.
async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  if (createdTenantIds.length > 0) {
    await step('delete applied_mutation', () =>
      db.query(`delete from applied_mutation where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete compliance_deadline', () =>
      db.query(`delete from compliance_deadline where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_closeout', () =>
      db.query(`delete from job_closeout where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job', () =>
      db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () =>
      db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete app_user', () =>
      db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id).then((success) => {
      if (!success) throw new Error('deleteAuthUser returned false');
    }));
  }
  if (createdTenantIds.length > 0) {
    await step('delete tenant', () =>
      db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

try {
  // ---- 0. Precondition: both new RPCs exist -----------------------------
  const precheck = await db.query(
    `select to_regprocedure('public.rpc_job_complete(uuid)') is not null as job_complete_applied,
            to_regprocedure('public.rpc_closeout_set_rework_cause(uuid, text)') is not null as rework_cause_applied`
  );
  if (!precheck.rows[0].job_complete_applied || !precheck.rows[0].rework_cause_applied) {
    console.error('\nOne or both new RPCs not found — run `npm run apply:rpc-supabase` first.');
    await db.end();
    process.exit(1);
  }
  ok('rpc_job_complete() and rpc_closeout_set_rework_cause() are both applied');

  // ---- fixtures: two tenants, one dispatched job each -------------------
  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Job-Complete Proof A ${suffix}`, `job-complete-proof-a-${suffix}`]
  );
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);

  const tenantB = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Job-Complete Proof B ${suffix}`, `job-complete-proof-b-${suffix}`]
  );
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `job-complete-a-${suffix}@device.fieldready.internal`;
  const emailB = `job-complete-b-${suffix}@device.fieldready.internal`;
  const password = 'proof-pass-verify-job-complete';

  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);

  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3)`,
    [authIdA, tenantAId, emailA]
  );
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`,
    [authIdB, tenantBId, emailB]
  );

  // A technician app_user WITH a real auth_user_id — not how technicians
  // are provisioned today (they have no Supabase session at all, §6 Step 5
  // review finding on rpc_closeout_set_rework_cause's role check), but
  // exactly the row shape that check has to defend against once
  // technician auth does migrate. Built here purely to prove the role
  // check actually rejects it now, not the day that migration lands.
  const emailTech = `job-complete-tech-${suffix}@device.fieldready.internal`;
  const authIdTech = await createAuthUser(emailTech, password);
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'technician', 'Técnico Proof', $3)`,
    [authIdTech, tenantAId, emailTech]
  );

  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantAId]);
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantBId]);

  async function insertDispatchedJob(tenantId, clientId, code) {
    const row = await db.query(
      `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
       values ($1, $2, $3, 'Job-complete proof job', 'TDT novo', 2, 50, 'dispatched')
       returning id;`,
      [tenantId, clientId, code]
    );
    return row.rows[0].id;
  }

  const jobAId = await insertDispatchedJob(tenantAId, clientA.rows[0].id, `JOBCOMP-A-${suffix}`);
  const jobBId = await insertDispatchedJob(tenantBId, clientB.rows[0].id, `JOBCOMP-B-${suffix}`);
  const jobAReadyCheckId = await (async () => {
    const row = await db.query(
      `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
       values ($1, $2, $3, 'Job-complete proof job (not dispatched)', 'TDT novo', 2, 50, 'ready_check')
       returning id;`,
      [tenantAId, clientA.rows[0].id, `JOBCOMP-A-RC-${suffix}`]
    );
    return row.rows[0].id;
  })();

  ok('fixtures: 2 tenants (ited_ready + basic), 2 office users, 3 jobs (2 dispatched, 1 ready_check)');

  const officeA = await signInAs(emailA, password);
  const officeB = await signInAs(emailB, password);

  // ---- 1. wrong_status: job still in ready_check ------------------------
  {
    const { data, error } = await officeA.rpc('rpc_job_complete', { p_job_id: jobAReadyCheckId });
    if (error) { fail('conflict: ready_check job rejected', error); }
    else if (data.kind === 'conflict' && data.status === 'ready_check') {
      ok(`conflict: ready_check job correctly rejected (status=${data.status})`);
    } else {
      fail('conflict: ready_check job rejected', new Error(JSON.stringify(data)));
    }
  }

  // ---- 2. RLS isolation: tenant B cannot complete tenant A's job --------
  {
    const { data, error } = await officeB.rpc('rpc_job_complete', { p_job_id: jobAId });
    if (error) { fail('RLS: tenant B blocked from tenant A job', error); }
    else if (data.kind === 'not_found') {
      ok('RLS: tenant B calling rpc_job_complete on tenant A\'s job returns not_found (RLS hides the row, not a 403)');
    } else {
      fail('RLS: tenant B blocked from tenant A job', new Error(`expected not_found, got ${JSON.stringify(data)}`));
    }
  }

  // Confirm the RLS check above didn't actually mutate tenant A's job.
  {
    const row = await db.query(`select status, completed_at from job where id = $1`, [jobAId]);
    if (row.rows[0].status === 'dispatched' && row.rows[0].completed_at === null) {
      ok('RLS: tenant A\'s job unchanged after tenant B\'s blocked attempt');
    } else {
      fail('RLS: tenant A\'s job unchanged after tenant B\'s blocked attempt', new Error(JSON.stringify(row.rows[0])));
    }
  }

  // ---- 3. happy path: ited_ready tenant, dispatched -> testing, ---------
  // ----    completed_at set, termo compliance_deadline inserted ----------
  {
    const { data, error } = await officeA.rpc('rpc_job_complete', { p_job_id: jobAId });
    if (error) { fail('ok: dispatched job completes', error); }
    else if (data.kind === 'ok' && data.status === 'testing' && data.completed_at) {
      ok(`ok: dispatched job -> testing, completed_at=${data.completed_at}`);
    } else {
      fail('ok: dispatched job completes', new Error(JSON.stringify(data)));
    }
  }
  {
    const deadlines = await db.query(
      `select kind, due_on from compliance_deadline where job_id = $1`, [jobAId]
    );
    if (deadlines.rows.length === 1 && deadlines.rows[0].kind === 'termo') {
      ok(`termo compliance_deadline inserted exactly once (due_on=${deadlines.rows[0].due_on})`);
    } else {
      fail('termo compliance_deadline inserted exactly once', new Error(JSON.stringify(deadlines.rows)));
    }
  }

  // ---- 4. re-calling on the now-completed job: conflict, no duplicate --
  {
    const { data, error } = await officeA.rpc('rpc_job_complete', { p_job_id: jobAId });
    if (error) { fail('conflict: already-completed job rejected on retry', error); }
    else if (data.kind === 'conflict' && data.status === 'testing' && data.completed_at) {
      ok('conflict: re-calling rpc_job_complete on the same job returns conflict, not a second apply');
    } else {
      fail('conflict: already-completed job rejected on retry', new Error(JSON.stringify(data)));
    }
  }
  {
    const deadlines = await db.query(
      `select count(*)::int as n from compliance_deadline where job_id = $1`, [jobAId]
    );
    if (deadlines.rows[0].n === 1) {
      ok('no duplicate compliance_deadline row from the retried call');
    } else {
      fail('no duplicate compliance_deadline row from the retried call', new Error(`count=${deadlines.rows[0].n}`));
    }
  }

  // ---- 5. basic-profile tenant: completes, but NO termo deadline --------
  {
    const { data, error } = await officeB.rpc('rpc_job_complete', { p_job_id: jobBId });
    if (error) { fail('ok: basic-profile tenant job completes', error); }
    else if (data.kind === 'ok' && data.status === 'testing') {
      ok('ok: basic-profile tenant\'s job also transitions to testing');
    } else {
      fail('ok: basic-profile tenant job completes', new Error(JSON.stringify(data)));
    }
  }
  {
    const deadlines = await db.query(
      `select count(*)::int as n from compliance_deadline where job_id = $1`, [jobBId]
    );
    if (deadlines.rows[0].n === 0) {
      ok('basic-profile tenant: no compliance_deadline row inserted (matches every other compliance route\'s gate)');
    } else {
      fail('basic-profile tenant: no compliance_deadline row inserted', new Error(`count=${deadlines.rows[0].n}`));
    }
  }

  // ---- 6. not_found: a job id that doesn't exist at all -----------------
  {
    const { data, error } = await officeA.rpc('rpc_job_complete', { p_job_id: '00000000-0000-0000-0000-000000000000' });
    if (error) { fail('not_found: nonexistent job id', error); }
    else if (data.kind === 'not_found') {
      ok('not_found: a job id that does not exist returns not_found, not an error');
    } else {
      fail('not_found: nonexistent job id', new Error(JSON.stringify(data)));
    }
  }

  // ---- 7. rpc_closeout_set_rework_cause() --------------------------------
  // rpc_job_complete already left jobAId in 'testing' with completed_at set
  // (checks 3-4 above) — submit a real closeout via the already-proven
  // rpc_closeout_submit (Step 4) to get a job_closeout row to write
  // rework_cause onto, the same precondition the Fastify route always had.
  {
    const { data, error } = await officeA.rpc('rpc_closeout_submit', {
      p_client_mutation_id: crypto.randomUUID(),
      p_job_id: jobAId,
      p_first_time_fix: false,
      p_technician_voice_note_file: null,
      p_technician_note_transcript: 'verify-job-complete.mjs fixture closeout.',
      p_client_signature_file: null,
    });
    if (error) { fail('setup: closeout submitted so rework_cause has a row to write onto', error); }
    else if (data.status === 'applied') {
      ok('setup: closeout submitted (rpc_closeout_submit, already proven in Step 4) for the rework_cause checks below');
    } else {
      fail('setup: closeout submitted', new Error(JSON.stringify(data)));
    }
  }

  // ---- 7a. RLS isolation: tenant B cannot set tenant A's rework_cause ----
  {
    const { data, error } = await officeB.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobAId, p_rework_cause: 'Material em falta',
    });
    if (error) { fail('RLS: tenant B blocked from tenant A rework_cause', error); }
    else if (data.kind === 'not_found') {
      ok('RLS: tenant B calling rpc_closeout_set_rework_cause on tenant A\'s job returns not_found');
    } else {
      fail('RLS: tenant B blocked from tenant A rework_cause', new Error(`expected not_found, got ${JSON.stringify(data)}`));
    }
  }

  // ---- 7b. happy path: office A sets its own job's rework_cause, ---------
  // ----     rework_cause_set_by resolved server-side (not client-supplied) -
  {
    const { data, error } = await officeA.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobAId, p_rework_cause: 'Erro de orçamento',
    });
    if (error) { fail('ok: office A sets rework_cause on its own job', error); }
    else if (data.kind === 'ok' && data.rework_cause === 'Erro de orçamento' && data.rework_cause_set_by) {
      ok(`ok: rework_cause set (rework_cause_set_by=${data.rework_cause_set_by}, resolved server-side)`);
    } else {
      fail('ok: office A sets rework_cause on its own job', new Error(JSON.stringify(data)));
    }
  }
  {
    // Independent confirmation via a direct superuser read — not just
    // trusting the RPC's own echoed return value — and that it actually
    // matches app_user.id for office A's signed-in session, not some other
    // row (the exact class of bug fn_current_app_user_id() exists to make
    // impossible, per schema.sql's own comment on it).
    const row = await db.query(
      `select jc.rework_cause, au.email
       from job_closeout jc join app_user au on au.id = jc.rework_cause_set_by
       where jc.job_id = $1`,
      [jobAId]
    );
    if (row.rows[0]?.rework_cause === 'Erro de orçamento' && row.rows[0]?.email === emailA) {
      ok(`independently confirmed: rework_cause_set_by resolves to office A's own app_user row (${emailA})`);
    } else {
      fail('independently confirmed: rework_cause_set_by resolves to office A', new Error(JSON.stringify(row.rows[0])));
    }
  }

  // ---- 7c. not_found: no job_closeout row exists for jobBId yet ---------
  {
    const { data, error } = await officeB.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobBId, p_rework_cause: 'Falha de equipamento',
    });
    if (error) { fail('not_found: no job_closeout row yet', error); }
    else if (data.kind === 'not_found') {
      ok('not_found: rework_cause on a job with no job_closeout row yet returns not_found, not an error');
    } else {
      fail('not_found: no job_closeout row yet', new Error(JSON.stringify(data)));
    }
  }

  // ---- 7d. empty rework_cause is rejected (raise exception) --------------
  {
    const { data, error } = await officeA.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobAId, p_rework_cause: '   ',
    });
    if (data && !error) { fail('rejects: whitespace-only rework_cause', new Error(JSON.stringify(data))); }
    else if (error) {
      ok(`rejects: whitespace-only rework_cause raises (${error.message})`);
    }
  }

  // ---- 7e. tab/newline-only rework_cause is ALSO rejected -----------------
  // Review finding (medium, confirmed and fixed): Postgres's bare trim()
  // strips only the ASCII space character by default, not tab/newline/CR —
  // the 7d check above (spaces only) would have passed against the OLD,
  // buggy guard too, so it never actually exercised this. This value uses
  // only a tab and a newline, deliberately no space, so it only passes if
  // the `!~ '\S'` fix is the one actually running.
  {
    const { data, error } = await officeA.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobAId, p_rework_cause: '\t\n',
    });
    if (data && !error) { fail('rejects: tab/newline-only rework_cause', new Error(JSON.stringify(data))); }
    else if (error) {
      ok(`rejects: tab/newline-only rework_cause raises (${error.message})`);
    }
  }

  // ---- 7f. a technician-role session is rejected (role gate) -------------
  // Review finding (low, confirmed and fixed): the Fastify route's
  // technician_cannot_set_rework_cause check wasn't ported at first
  // (justified as "no technician Supabase session exists yet, so it's
  // unreachable" — true operationally, enforced by nothing). Now checked
  // for real inside the function itself, proven here against a technician
  // app_user row that DOES have a real auth session (not how technicians
  // are provisioned today, but exactly the shape this check has to survive
  // once that migration lands).
  {
    const technician = await signInAs(emailTech, password);
    const { data, error } = await technician.rpc('rpc_closeout_set_rework_cause', {
      p_job_id: jobAId, p_rework_cause: 'Erro de instalação',
    });
    if (data && !error) { fail('rejects: technician-role session', new Error(JSON.stringify(data))); }
    else if (error) {
      ok(`rejects: technician-role session raises (${error.message})`);
    }
  }

  console.log(`\n${reporter.failures === 0 ? 'All' : reporter.failures + ' of the'} verify-job-complete.mjs checks ${reporter.failures === 0 ? 'passed' : 'FAILED'}.`);
  if (reporter.failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
