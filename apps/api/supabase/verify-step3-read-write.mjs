// FieldReady — §6 Step 3: one real read path, one real write path.
// 08-supabase-native-migration.md §6 step 3 / §4.
//
// Chosen pair, per the design doc's own example: job list read (RLS alone)
// + checklist_item.update write (RLS + an RPC function, rpc.sql). Both
// exercised through the real HTTP surface a browser/phone would use — real
// Supabase Auth sign-in, real PostgREST reads, real supabase.rpc() calls —
// not simulated GUCs (verify-schema-supabase.mjs's job) and not raw
// superuser SQL except for fixture setup and independently confirming what
// actually landed in the database.
//
// Assumes schema.sql (§6 Step 1) AND rpc.sql (§6 Step 3) are already
// applied. Does not reset either — only adds/cleans up its own fixtures.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-step3-read-write.mjs

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
    'Run as: cd apps/api && node --env-file=.env supabase/verify-step3-read-write.mjs'
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
  if (!data.session) throw new Error(`sign-in for ${email} returned no session`);
  return client;
}

const createdTenantIds = [];

// job_checklist_item/job/client/technician_device/app_user have no ON DELETE
// CASCADE from tenant (deliberately — real production data shouldn't vanish
// on a tenant delete by accident), so this test-only cleanup deletes in
// explicit dependency order instead of relying on cascade. A first version
// of this function swallowed every step's error with `.catch(() => {})` and
// never explicitly deleted technician_device/app_user rows at all — that
// left them stranded (technician_device.auth_user_id has no ON DELETE
// action, by design, so deleteAuthUser on a technician's auth id silently
// failed too, caught by the same blanket swallow), which in turn blocked
// the tenant delete itself, also silently swallowed. Confirmed empirically
// against the real project (4 stray tenant rows survived a "successful"
// cleanup) rather than assumed fixed — every step below now logs a failure
// instead of hiding it, and technician_device is deleted BEFORE the auth
// users it references, not left for a cascade that doesn't exist.
async function cleanupFixtures() {
  async function step(label, fn) {
    try {
      await fn();
    } catch (err) {
      console.log(`  (cleanup warning: ${label} -> ${err.message})`);
    }
  }

  if (createdTenantIds.length > 0) {
    await step('delete technician_device', () =>
      db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id).then((success) => {
      if (!success) throw new Error('deleteAuthUser returned false');
    }));
  }
  if (createdTenantIds.length > 0) {
    await step('delete applied_mutation', () =>
      db.query(`delete from applied_mutation where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job_checklist_item', () =>
      db.query(`delete from job_checklist_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job', () =>
      db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () =>
      db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete remaining app_user rows', () =>
      db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete tenant', () =>
      db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

// ---- 0. Preconditions: schema.sql AND rpc.sql are both applied -----------

try {
  const r = await db.query(`
    select
      to_regproc('public.fn_current_tenant_id') is not null as schema_applied,
      to_regprocedure('public.rpc_checklist_item_update(uuid, uuid, uuid, text)') is not null as rpc_applied
  `);
  if (!r.rows[0].schema_applied) {
    console.error('\nfn_current_tenant_id() not found — run `npm run verify:schema-supabase` first.');
    await db.end();
    process.exit(1);
  }
  if (!r.rows[0].rpc_applied) {
    console.log('rpc_checklist_item_update() not found — applying rpc.sql now ...');
    const { readFileSync } = await import('node:fs');
    const rpcSql = readFileSync(new URL('./rpc.sql', import.meta.url), 'utf8');
    await db.query(rpcSql);
  }
  ok('schema.sql and rpc.sql are applied');
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

// ---- fixtures: two tenants, one office + one technician (paired device)
// per tenant, one job + one job_checklist_item per tenant --------------

const tenantA = crypto.randomUUID();
const tenantB = crypto.randomUUID();
const marker = crypto.randomUUID().slice(0, 8);

let officeAAuthId, officeBAuthId, techAAuthId, techBAuthId;
let jobAId, jobBId, itemAId, itemBId;

async function makeTenantFixture(tenantId, label) {
  const officeEmail = `office-rw-${label}-${marker}@device.fieldready.internal`;
  const officePassword = 'Verify-RW-Test-Passw0rd!';
  const officeAuthId = await createAuthUser(officeEmail, officePassword);
  const officeAppUserId = crypto.randomUUID();
  await db.query(
    `insert into app_user (id, auth_user_id, tenant_id, role, full_name, email) values ($1, $2, $3, 'owner', $4, $5)`,
    [officeAppUserId, officeAuthId, tenantId, `Office ${label}`, officeEmail]
  );

  const techAppUserId = crypto.randomUUID();
  await db.query(
    `insert into app_user (id, tenant_id, role, full_name) values ($1, $2, 'technician', $3)`,
    [techAppUserId, tenantId, `Tech ${label}`]
  );
  const techAuthId = await createAuthUser(`device-rw-${label}-${marker}@device.fieldready.internal`, '1234-device-secret');
  await db.query(
    `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by) values ($1, $2, $3, $4, $5)`,
    [tenantId, techAppUserId, `Device ${label}`, techAuthId, officeAppUserId]
  );

  const client = await db.query(`insert into client (tenant_id, name) values ($1, $2) returning id`, [tenantId, `Cliente ${label}`]);
  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, assigned_to)
     values ($1, $2, $3, $4, 'TDT novo', 3, 100, $5) returning id`,
    [tenantId, client.rows[0].id, `JOB-RW-${label}-${marker}`, `Teste RW ${label}`, techAppUserId]
  );
  const item = await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status)
     values ($1, $2, 'material', 'Antena', 'job', true, 'missing') returning id`,
    [tenantId, job.rows[0].id]
  );

  return { officeAuthId, techAuthId, officeEmail, officePassword, jobId: job.rows[0].id, itemId: item.rows[0].id };
}

try {
  await db.query(
    `insert into tenant (id, name, slug) values ($1, 'Antenas Rex, Lda', $2), ($3, 'Outro Instalador, Lda', $4)`,
    [tenantA, `antenas-rex-rw-${marker}`, tenantB, `outro-instalador-rw-${marker}`]
  );
  createdTenantIds.push(tenantA, tenantB);

  const fxA = await makeTenantFixture(tenantA, 'a');
  const fxB = await makeTenantFixture(tenantB, 'b');
  officeAAuthId = fxA.officeAuthId; techAAuthId = fxA.techAuthId; jobAId = fxA.jobId; itemAId = fxA.itemId;
  officeBAuthId = fxB.officeAuthId; techBAuthId = fxB.techAuthId; jobBId = fxB.jobId; itemBId = fxB.itemId;

  ok('fixtures created: 2 tenants, office + paired technician device each, 1 job + 1 checklist item each');

  // Only office B's real login is needed below (paired with technician A's
  // session to exercise both identity paths across the two tenants) —
  // office A's credentials are created for symmetry/realism but its session
  // is never signed into in this script.
  var fxBEmail = fxB.officeEmail, fxBPassword = fxB.officePassword;
} catch (err) {
  fail('fixture setup', err);
  console.log('\nFixture setup failed — cleaning up whatever was created, then stopping.');
  await cleanupFixtures();
  await db.end();
  process.exit(1);
}

// technician sign-in needs its own synthetic email — recover it from the DB
// rather than threading another return value through, simplest given
// createAuthUser already logged the real address into auth.users.
async function techEmailFor(authId) {
  const res = await fetch(`${authApiBase}/admin/users/${authId}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const body = await res.json();
  return body.email;
}

let techASession, officeBSession;

// ---- 1. READ PATH: real signed-in session, real PostgREST, RLS-scoped ---

try {
  const techAEmail = await techEmailFor(techAAuthId);
  techASession = await signInAs(techAEmail, '1234-device-secret');
  const { data, error } = await techASession.from('job').select('id, code');
  if (error) throw error;
  if (data.length === 1 && data[0].id === jobAId) {
    ok("READ: technician A's real PostgREST query on `job` returns exactly its own tenant's 1 job");
  } else {
    fail('read path (technician A)', new Error(`expected [jobA], got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('read path (technician A)', err);
}

try {
  officeBSession = await signInAs(fxBEmail, fxBPassword);
  const { data, error } = await officeBSession.from('job').select('id, code');
  if (error) throw error;
  if (data.length === 1 && data[0].id === jobBId) {
    ok("READ: office B's real PostgREST query on `job` returns exactly its own tenant's 1 job (cross-tenant isolation)");
  } else {
    fail('read path (office B)', new Error(`expected [jobB], got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('read path (office B)', err);
}

// ---- 2. WRITE PATH: real supabase.rpc() call, first application ---------

const clientMutationId = crypto.randomUUID();

if (techASession) {
  try {
    const { data, error } = await techASession.rpc('rpc_checklist_item_update', {
      p_client_mutation_id: clientMutationId,
      p_job_id: jobAId,
      p_item_id: itemAId,
      p_status: 'ok',
    });
    if (error) throw error;
    if (data.status === 'applied') {
      ok('WRITE: technician A applies checklist_item.update via the real RPC (status=applied)');
    } else {
      fail('write path (first apply)', new Error(`expected status=applied, got ${JSON.stringify(data)}`));
    }

    const row = await db.query(`select status from job_checklist_item where id = $1`, [itemAId]);
    if (row.rows[0].status === 'ok') {
      ok("WRITE: independently confirmed job_checklist_item's status is really 'ok' in the database");
    } else {
      fail('write path (db confirmation)', new Error(`expected status=ok, got ${row.rows[0].status}`));
    }
  } catch (err) {
    fail('write path (first apply)', err);
  }
}

// ---- 3. IDEMPOTENT REPLAY: same client_mutation_id, second call ---------
// The client-observable half of the SIGKILL-mid-sync guarantee the other
// three proof:phaseN scripts prove by actually killing a process: a client
// that retries after not receiving a response must get back the same
// recorded result, not a double-effect. The other half — that Postgres
// itself never leaves a half-committed transaction on a crash — is a
// platform guarantee this migration inherits from Supabase's managed
// Postgres rather than something this proof re-derives, unlike Phase 1-4's
// hand-rolled Fastify+PGlite process this migration is replacing.

if (techASession) {
  try {
    const { data, error } = await techASession.rpc('rpc_checklist_item_update', {
      p_client_mutation_id: clientMutationId,
      p_job_id: jobAId,
      p_item_id: itemAId,
      p_status: 'ok',
    });
    if (error) throw error;
    if (data.status === 'already_applied') {
      ok('WRITE: replaying the identical client_mutation_id returns already_applied (idempotent)');
    } else {
      fail('write path (replay)', new Error(`expected status=already_applied, got ${JSON.stringify(data)}`));
    }

    const dupes = await db.query(
      `select count(*)::int as n from applied_mutation where client_mutation_id = $1`,
      [clientMutationId]
    );
    if (dupes.rows[0].n === 1) {
      ok('WRITE: exactly one applied_mutation row exists for this client_mutation_id (no double-insert)');
    } else {
      fail('write path (no double-insert)', new Error(`expected exactly 1 row, got ${dupes.rows[0].n}`));
    }
  } catch (err) {
    fail('write path (replay)', err);
  }
}

// ---- 4. CROSS-TENANT WRITE REJECTION: technician B targets tenant A's data

try {
  const techBEmail = await techEmailFor(techBAuthId);
  const techBSession = await signInAs(techBEmail, '1234-device-secret');
  const crossMutationId = crypto.randomUUID();

  const { data, error } = await techBSession.rpc('rpc_checklist_item_update', {
    p_client_mutation_id: crossMutationId,
    p_job_id: jobAId,
    p_item_id: itemAId,
    p_status: 'missing',
  });
  if (error) throw error;
  if (data.status === 'rejected' && data.reason === 'item_not_found') {
    ok("WRITE: technician B targeting tenant A's checklist item is rejected (item_not_found — RLS makes it invisible, not a leak)");
  } else {
    fail('cross-tenant write rejection', new Error(`expected rejected/item_not_found, got ${JSON.stringify(data)}`));
  }

  const row = await db.query(`select status from job_checklist_item where id = $1`, [itemAId]);
  if (row.rows[0].status === 'ok') {
    ok("WRITE: tenant A's item is unchanged after the cross-tenant attempt (still 'ok')");
  } else {
    fail('cross-tenant write rejection (db confirmation)', new Error(`expected status=ok (unchanged), got ${row.rows[0].status}`));
  }
} catch (err) {
  fail('cross-tenant write rejection', err);
}

// ---- 5. Invalid status is rejected, not silently accepted ----------------

if (techASession) {
  try {
    const { error } = await techASession.rpc('rpc_checklist_item_update', {
      p_client_mutation_id: crypto.randomUUID(),
      p_job_id: jobAId,
      p_item_id: itemAId,
      p_status: 'bogus',
    });
    if (error) ok('WRITE: an invalid status value is rejected by the RPC');
    else fail('invalid status rejection', new Error('call unexpectedly succeeded'));
  } catch (err) {
    fail('invalid status rejection', err);
  }
}

// ---- 6. No session at all cannot call the RPC either ---------------------

try {
  const client = anonClient();
  const { error } = await client.rpc('rpc_checklist_item_update', {
    p_client_mutation_id: crypto.randomUUID(),
    p_job_id: jobAId,
    p_item_id: itemAId,
    p_status: 'ok',
  });
  if (error) ok('WRITE: an unauthenticated caller cannot invoke the RPC either (fail-safe)');
  else fail('unauthenticated RPC call', new Error('call unexpectedly succeeded'));
} catch (err) {
  fail('unauthenticated RPC call', err);
}

// ---- cleanup ---------------------------------------------------------------

console.log(`\nCleaning up ${createdAuthUserIds.length} test auth user(s) and fixture rows ...`);
await cleanupFixtures();

await db.end();

console.log('\n' + (reporter.failures === 0
  ? `All checks passed.`
  : `${reporter.failures} check(s) failed — see FAIL lines above.`));
process.exit(reporter.failures === 0 ? 0 : 1);
