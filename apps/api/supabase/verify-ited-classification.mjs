// FieldReady — verifies rpc_job_ited_classification_review(), a later
// addition beyond §6 Step 5's original scope (rpc.sql's own comment above
// the function explains why it qualifies: schema.sql's job-table comment
// names this exact gap directly — RLS alone let ANY tenant member write
// job.ited_classification via a plain `.from('job').update(...)`, and every
// verify-*.mjs script needing a "reviewed" job wrote straight to the
// database with the service-role connection, because no real caller path
// existed yet).
//
// Exercised through the real HTTP surface a browser would use — real
// Supabase Auth sign-in, real supabase.rpc() calls — same rigor as
// verify-job-complete.mjs / verify-step4-rpc.mjs, not simulated GUCs.
//
// Assumes schema.sql and rpc.sql (including rpc_job_ited_classification_review
// — apply with `npm run apply:rpc-supabase` if missing) are already applied.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-ited-classification.mjs

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
    'Run as: cd apps/api && node --env-file=.env supabase/verify-ited-classification.mjs'
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

// Same cleanup-ordering constraint verify-job-complete.mjs's own comment
// documents: app_user.auth_user_id references auth.users(id) with no ON
// DELETE action, so app_user (and everything else) must go before the auth
// users themselves.
async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  if (createdTenantIds.length > 0) {
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
  // ---- 0. Precondition: the RPC exists -----------------------------------
  const precheck = await db.query(
    `select to_regprocedure('public.rpc_job_ited_classification_review(uuid, text, text)') is not null as applied`
  );
  if (!precheck.rows[0].applied) {
    console.error('\nrpc_job_ited_classification_review not found — run `npm run apply:rpc-supabase` first.');
    await db.end();
    process.exit(1);
  }
  ok('rpc_job_ited_classification_review() is applied');

  // ---- fixtures: 2 tenants, office A/B, a technician with a real session,
  // ----           1 job each -----------------------------------------------
  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`ITED-Classification Proof A ${suffix}`, `ited-class-proof-a-${suffix}`]
  );
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);

  const tenantB = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`ITED-Classification Proof B ${suffix}`, `ited-class-proof-b-${suffix}`]
  );
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `ited-class-a-${suffix}@device.fieldready.internal`;
  const emailB = `ited-class-b-${suffix}@device.fieldready.internal`;
  const emailTech = `ited-class-tech-${suffix}@device.fieldready.internal`;
  const password = 'proof-pass-verify-ited-classification';

  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);
  const authIdTech = await createAuthUser(emailTech, password);

  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3)`,
    [authIdA, tenantAId, emailA]
  );
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`,
    [authIdB, tenantBId, emailB]
  );
  // A technician app_user WITH a real auth_user_id — same deliberate
  // not-how-it's-provisioned-today shape verify-job-complete.mjs's own
  // comment on this explains: built purely to prove the role check rejects
  // it now, not the day technician auth actually migrates to Supabase.
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'technician', 'Técnico Proof', $3)`,
    [authIdTech, tenantAId, emailTech]
  );

  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantAId]);
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantBId]);

  async function insertJob(tenantId, clientId, code) {
    const row = await db.query(
      `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
       values ($1, $2, $3, 'ITED classification proof job', 'TDT novo', 2, 50, 'ready_check')
       returning id, ited_classification, ited_classification_note, ited_classification_by;`,
      [tenantId, clientId, code]
    );
    return row.rows[0];
  }

  const jobA = await insertJob(tenantAId, clientA.rows[0].id, `ITEDCLASS-A-${suffix}`);
  const jobB = await insertJob(tenantBId, clientB.rows[0].id, `ITEDCLASS-B-${suffix}`);

  ok('fixtures: 2 tenants, 2 office users, 1 technician (real session), 2 jobs (default ited_classification)');

  if (jobA.ited_classification === 'existing_alteration' && jobA.ited_classification_by === null) {
    ok('fixture job defaults to existing_alteration, unreviewed (ited_classification_by null) — matches the schema default');
  } else {
    fail('fixture job defaults to existing_alteration, unreviewed', new Error(JSON.stringify(jobA)));
  }

  const officeA = await signInAs(emailA, password);
  const officeB = await signInAs(emailB, password);

  // ---- 1. invalid enum value is rejected ---------------------------------
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'not_a_real_value',
    });
    if (data && !error) { fail('rejects: invalid ited_classification enum value', new Error(JSON.stringify(data))); }
    else if (error) { ok(`rejects: invalid ited_classification enum value raises (${error.message})`); }
  }

  // ---- 2. out_of_scope with no note is rejected --------------------------
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'out_of_scope',
    });
    if (data && !error) { fail('rejects: out_of_scope with no note', new Error(JSON.stringify(data))); }
    else if (error) { ok(`rejects: out_of_scope with no note raises (${error.message})`); }
  }

  // ---- 3. exempt with a whitespace-only note is ALSO rejected ------------
  // Same '\S' bug shape rpc_closeout_set_rework_cause's own fix already
  // covers — a tab/newline-only value (deliberately no plain space) only
  // passes if that same fix is what's actually running here too.
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'exempt', p_ited_classification_note: '\t\n',
    });
    if (data && !error) { fail('rejects: exempt with a whitespace-only note', new Error(JSON.stringify(data))); }
    else if (error) { ok(`rejects: exempt with a whitespace-only note raises (${error.message})`); }
  }

  // ---- 4. a technician-role session is rejected (role gate) --------------
  {
    const technician = await signInAs(emailTech, password);
    const { data, error } = await technician.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'existing_alteration',
    });
    if (data && !error) { fail('rejects: technician-role session', new Error(JSON.stringify(data))); }
    else if (error) { ok(`rejects: technician-role session raises (${error.message})`); }
  }

  // Confirm none of checks 1-4 actually mutated jobA.
  {
    const row = await db.query(
      `select ited_classification, ited_classification_note, ited_classification_by from job where id = $1`, [jobA.id]
    );
    if (row.rows[0].ited_classification === 'existing_alteration' && row.rows[0].ited_classification_by === null) {
      ok('jobA unchanged after all four rejected attempts above');
    } else {
      fail('jobA unchanged after all four rejected attempts', new Error(JSON.stringify(row.rows[0])));
    }
  }

  // ---- 5. RLS isolation: tenant B cannot review tenant A's job -----------
  {
    const { data, error } = await officeB.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'exempt', p_ited_classification_note: 'Tentativa de outro tenant',
    });
    if (error) { fail('RLS: tenant B blocked from tenant A\'s job', error); }
    else if (data.kind === 'not_found') {
      ok('RLS: tenant B calling on tenant A\'s job returns not_found (RLS hides the row, not a leak)');
    } else {
      fail('RLS: tenant B blocked from tenant A\'s job', new Error(`expected not_found, got ${JSON.stringify(data)}`));
    }
  }

  // ---- 6. not_found: a job id that doesn't exist at all ------------------
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: '00000000-0000-0000-0000-000000000000', p_ited_classification: 'existing_alteration',
    });
    if (error) { fail('not_found: nonexistent job id', error); }
    else if (data.kind === 'not_found') {
      ok('not_found: a job id that does not exist returns not_found, not an error');
    } else {
      fail('not_found: nonexistent job id', new Error(JSON.stringify(data)));
    }
  }

  // ---- 7. happy path: office A reviews its own job to out_of_scope, ------
  // ----    with a real note, ited_classification_by resolved server-side --
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'out_of_scope', p_ited_classification_note: 'Substituição pontual de LNB.',
    });
    if (error) { fail('ok: office A reviews its own job to out_of_scope', error); }
    else if (
      data.kind === 'ok' &&
      data.ited_classification === 'out_of_scope' &&
      data.ited_classification_note === 'Substituição pontual de LNB.' &&
      data.ited_classification_by
    ) {
      ok(`ok: reviewed to out_of_scope, ited_classification_by=${data.ited_classification_by} (resolved server-side)`);
    } else {
      fail('ok: office A reviews its own job to out_of_scope', new Error(JSON.stringify(data)));
    }
  }
  {
    // Independent confirmation via a direct superuser read, resolving
    // ited_classification_by to office A's own app_user row by email — not
    // just trusting the RPC's own echoed return value, same discipline
    // verify-job-complete.mjs applies to rework_cause_set_by.
    const row = await db.query(
      `select j.ited_classification, j.ited_classification_note, au.email
       from job j join app_user au on au.id = j.ited_classification_by
       where j.id = $1`,
      [jobA.id]
    );
    if (row.rows[0]?.ited_classification === 'out_of_scope' && row.rows[0]?.email === emailA) {
      ok(`independently confirmed: ited_classification_by resolves to office A's own app_user row (${emailA})`);
    } else {
      fail('independently confirmed: ited_classification_by resolves to office A', new Error(JSON.stringify(row.rows[0])));
    }
  }

  // ---- 8. re-reviewing to existing_alteration clears the note -----------
  // Ports the classic route's own `body.ited_classification_note ?? null`
  // behavior exactly (routes/jobs.ts) — always overwrites, never merges —
  // proven here by switching AWAY from a note-requiring classification and
  // confirming the previously-set note is actually cleared, not left stale.
  {
    const { data, error } = await officeA.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobA.id, p_ited_classification: 'existing_alteration',
    });
    if (error) { fail('ok: re-review to existing_alteration clears the note', error); }
    else if (data.kind === 'ok' && data.ited_classification === 'existing_alteration' && data.ited_classification_note === null) {
      ok('ok: re-review to existing_alteration clears ited_classification_note to null (overwrite, not merge)');
    } else {
      fail('ok: re-review to existing_alteration clears the note', new Error(JSON.stringify(data)));
    }
  }

  // ---- 9. basic-profile tenant can also be reviewed (this RPC doesn't ----
  // ----    gate on compliance_profile — only rpc_dispatch_job's condition
  // ----    (d) does, and only for whether it BLOCKS on it) ----------------
  {
    const { data, error } = await officeB.rpc('rpc_job_ited_classification_review', {
      p_job_id: jobB.id, p_ited_classification: 'licensed',
    });
    if (error) { fail('ok: basic-profile tenant\'s own job can be reviewed', error); }
    else if (data.kind === 'ok' && data.ited_classification === 'licensed') {
      ok('ok: basic-profile tenant\'s own job can be reviewed too (this RPC is not gated by compliance_profile)');
    } else {
      fail('ok: basic-profile tenant\'s own job can be reviewed', new Error(JSON.stringify(data)));
    }
  }

  console.log(`\n${reporter.failures === 0 ? 'All' : reporter.failures + ' of the'} verify-ited-classification.mjs checks ${reporter.failures === 0 ? 'passed' : 'FAILED'}.`);
  if (reporter.failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
