// FieldReady — Supabase-native office-auth verification. §6 Step 2 of
// 08-supabase-native-migration.md.
//
// Proves the actual claim §6 step 2 makes: a real office user can log in
// via Supabase Auth (anon key, password sign-in — the exact mechanism a
// real browser uses) and see only their own tenant's data through RLS
// alone, with zero Fastify route anywhere in the path. Where
// verify-schema-supabase.mjs simulates auth.uid() via directly-set Postgres
// GUCs (fast, precise, right tool for schema-shape questions), this script
// goes through the real HTTP surface end to end: Supabase Auth's public
// sign-in endpoint, then a real PostgREST query using the session the
// anon-key client receives back — the actual code path a browser takes,
// not a simulation of it.
//
// Assumes schema.sql (§6 Step 1) is already applied — this script does NOT
// reset/reapply the schema itself, only adds and cleans up its own
// fixtures (tenant/app_user/client rows + real auth.users rows). Sweeps
// leftover test auth users by their shared email suffix at the START of
// every run (same pattern verify-schema-supabase.mjs uses) so a partial
// failure mid-setup — or an interrupted run — doesn't strand real
// auth.users rows on the live project indefinitely; a security review of
// an earlier draft confirmed this file was missing that sweep entirely,
// unlike its sibling script.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-office-auth.mjs

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
    'Run as: cd apps/api && node --env-file=.env supabase/verify-office-auth.mjs'
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

// Real browser-equivalent client: anon key only, its own independent
// session (never shares state with another signInWithPassword call) —
// deliberately a fresh instance per "user", the same way two separate
// browser tabs/devices would never share an in-memory session.
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

// Fixture rows this run creates directly (not via the Auth cascade) —
// tracked so the failure path can clean them up too, not just the success
// path. Security review (medium/high, confirmed): the earlier draft's
// fixture-setup catch block called process.exit(1) without ever walking
// this, leaking real tenant/client rows (and, via createdAuthUserIds, real
// auth.users rows) on a partial failure.
const createdTenantIds = [];

async function cleanupFixtures() {
  for (const id of createdAuthUserIds) await deleteAuthUser(id).catch(() => {});
  if (createdTenantIds.length > 0) {
    await db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]).catch(() => {});
    await db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]).catch(() => {});
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

// ---- 0. Precondition: schema.sql (§6 Step 1) is actually applied --------

try {
  const r = await db.query(`select to_regproc('public.fn_current_tenant_id') is not null as exists`);
  if (!r.rows[0].exists) {
    console.error(
      '\nfn_current_tenant_id() not found — run `npm run verify:schema-supabase` first ' +
      '(§6 Step 1) before this script.'
    );
    await db.end();
    process.exit(1);
  }
  ok('schema.sql (§6 Step 1) is applied');
} catch (err) {
  fail('schema precondition', err);
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

// ---- fixtures: two tenants, two real office users with real Supabase Auth
// logins, one client row per tenant --------------------------------------

const tenantA = crypto.randomUUID();
const tenantB = crypto.randomUUID();
const marker = crypto.randomUUID().slice(0, 8);
const officeAEmail = `office-auth-a-${marker}@device.fieldready.internal`;
const officeBEmail = `office-auth-b-${marker}@device.fieldready.internal`;
const password = 'Verify-Office-Auth-Test-Passw0rd!';

let officeAAuthId, officeBAuthId, clientAId, clientBId;

try {
  await db.query(
    `insert into tenant (id, name, slug) values ($1, 'Antenas Rex, Lda', $2), ($3, 'Outro Instalador, Lda', $4)`,
    [tenantA, `antenas-rex-oa-${marker}`, tenantB, `outro-instalador-oa-${marker}`]
  );
  createdTenantIds.push(tenantA, tenantB);

  officeAAuthId = await createAuthUser(officeAEmail, password);
  officeBAuthId = await createAuthUser(officeBEmail, password);

  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Rex (office A)', $3)`,
    [officeAAuthId, tenantA, officeAEmail]
  );
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Someone (office B)', $3)`,
    [officeBAuthId, tenantB, officeBEmail]
  );

  const cA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantA]);
  const cB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantB]);
  clientAId = cA.rows[0].id;
  clientBId = cB.rows[0].id;

  ok('fixtures created: 2 tenants, 2 real Supabase Auth office users, 1 client row each');
} catch (err) {
  fail('fixture setup', err);
  console.log('\nFixture setup failed — cleaning up whatever was created, then stopping.');
  await cleanupFixtures();
  await db.end();
  process.exit(1);
}

// ---- 1. Real sign-in via Supabase Auth (anon key, password) — no Fastify -

let sessionA, sessionB;
try {
  sessionA = await signInAs(officeAEmail, password);
  ok('office A signs in via Supabase Auth (real HTTP, anon key, zero Fastify)');
} catch (err) {
  fail('office A sign-in', err);
}

try {
  sessionB = await signInAs(officeBEmail, password);
  ok('office B signs in via Supabase Auth (real HTTP, anon key, zero Fastify)');
} catch (err) {
  fail('office B sign-in', err);
}

// ---- 2. Wrong password is rejected (cheap correctness check, real endpoint)

try {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: officeAEmail, password: 'not-the-real-password' });
  if (error) ok('sign-in with the wrong password is rejected by Supabase Auth');
  else fail('wrong-password rejection', new Error('sign-in unexpectedly succeeded'));
} catch (err) {
  fail('wrong-password rejection', err);
}

// ---- 3. Real PostgREST read, through the signed-in session, is RLS-scoped

if (sessionA) {
  try {
    const { data, error } = await sessionA.from('client').select('*');
    if (error) throw error;
    if (data.length === 1 && data[0].id === clientAId) {
      ok("office A's real PostgREST query returns exactly its own tenant's 1 client row");
    } else {
      fail('office A RLS-scoped read', new Error(`expected [clientA], got ${JSON.stringify(data)}`));
    }
  } catch (err) {
    fail('office A RLS-scoped read', err);
  }
}

if (sessionB) {
  try {
    const { data, error } = await sessionB.from('client').select('*');
    if (error) throw error;
    if (data.length === 1 && data[0].id === clientBId) {
      ok("office B's real PostgREST query returns exactly its own tenant's 1 client row (cross-tenant isolation holds over real HTTP)");
    } else {
      fail('office B RLS-scoped read', new Error(`expected [clientB], got ${JSON.stringify(data)}`));
    }
  } catch (err) {
    fail('office B RLS-scoped read', err);
  }
}

// ---- 4. tenant table itself: each office user sees only their own row ----

if (sessionA) {
  try {
    const { data, error } = await sessionA.from('tenant').select('*');
    if (error) throw error;
    if (data.length === 1 && data[0].id === tenantA) {
      ok("office A's real PostgREST query on `tenant` returns only its own tenant row");
    } else {
      fail('tenant table RLS (office A, real HTTP)', new Error(`expected [tenantA], got ${JSON.stringify(data)}`));
    }
  } catch (err) {
    fail('tenant table RLS (office A, real HTTP)', err);
  }
}

// ---- 5. No session at all (a real anon request, never signed in) fails safe

try {
  const client = anonClient();
  const { data, error } = await client.from('client').select('*');
  if (error) {
    ok('unauthenticated real PostgREST request is rejected (fail-safe, no leak)');
  } else if (Array.isArray(data) && data.length === 0) {
    ok('unauthenticated real PostgREST request returns zero rows (fail-safe)');
  } else {
    fail('unauthenticated RLS fail-safe (real HTTP)', new Error(`expected 0 rows or an error, got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('unauthenticated RLS fail-safe (real HTTP)', err);
}

// ---- 6. The anon key alone carries no elevated power — Admin API rejects it

try {
  const res = await fetch(`${authApiBase}/admin/users`, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `should-never-exist-${marker}@device.fieldready.internal`, password: 'x', email_confirm: true }),
  });
  if (res.status === 401 || res.status === 403) {
    ok(`the anon key cannot call the Auth Admin API (${res.status}, as it must not)`);
  } else {
    fail('anon key privilege check', new Error(`expected 401/403, got ${res.status}`));
  }
} catch (err) {
  fail('anon key privilege check', err);
}

// ---- cleanup ---------------------------------------------------------------
// Deleting the real auth users cascades to their app_user rows automatically
// (app_user.auth_user_id is `on delete cascade`, by design — see schema.sql
// §2). client/tenant rows have no cascading FK from auth.users, so those are
// cleaned up directly afterward via the same cleanupFixtures() the failure
// path above also uses.

console.log(`\nCleaning up ${createdAuthUserIds.length} test auth user(s) and fixture rows ...`);
await cleanupFixtures();

await db.end();

console.log('\n' + (reporter.failures === 0
  ? `All checks passed.`
  : `${reporter.failures} check(s) failed — see FAIL lines above.`));
process.exit(reporter.failures === 0 ? 0 : 1);
