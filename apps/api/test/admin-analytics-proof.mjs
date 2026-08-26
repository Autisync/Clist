// Proof for the platform-admin cross-tenant analytics read (schema.sql's
// job_platform_admin_read policy, applied live via
// apply-admin-analytics.mjs) — the read half of the "superadmin dashboard"
// ask, backing admin/page.tsx's compliance-profile and job-status tallies.
// Real, direct PostgREST calls against the real Supabase project, same
// "no Fastify server needed for a plain RLS-scoped read" shape as
// support-tickets-proof.mjs.
//
// Cleanup scope: every row this script deletes is matched by ITS OWN
// randomly-suffixed tenant ids, never a broad table-wide sweep — this
// project is shared with at least one other concurrent session (real
// data: antenas-rex-sb, outro-instalador-sb, fieldready-internal).
//
// Usage:
//   cd apps/api && node --env-file=.env test/admin-analytics-proof.mjs

import { Client } from 'pg';
import { pgClientConfig, createAuthAdmin } from '../supabase/verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.');
  process.exit(1);
}

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`); }

const restBase = `https://${projectRef}.supabase.co/rest/v1`;

async function pg(method, path, token, body) {
  const headers = { apikey: anonKey, authorization: `Bearer ${token}`, prefer: 'return=representation' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${restBase}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;
const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser } = createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds });
const db = new Client(pgClientConfig(projectRef, dbPassword));

async function signIn(email, password) {
  const res = await fetch(`${authApiBase}/token?grant_type=password`, {
    method: 'POST', headers: { 'content-type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
}

const createdTenantIds = [];
const createdPlatformAdminIds = [];
async function cleanupFixtures() {
  async function step(label, fn) { try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); } }
  if (createdTenantIds.length > 0) {
    await step('delete job', () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete app_user', () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete tenant', () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
  if (createdPlatformAdminIds.length > 0) {
    await step('delete platform_admin', () => db.query(`delete from platform_admin where id = any($1::uuid[])`, [createdPlatformAdminIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Admin Analytics Proof A ${suffix}`, `admin-analytics-proof-a-${suffix}`]);
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);
  const tenantB = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Admin Analytics Proof B ${suffix}`, `admin-analytics-proof-b-${suffix}`]);
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `admin-analytics-a-${suffix}@device.fieldready.internal`;
  const emailB = `admin-analytics-b-${suffix}@device.fieldready.internal`;
  const password = 'admin-analytics-proof-password-123';
  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3)`, [authIdA, tenantAId, emailA]);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`, [authIdB, tenantBId, emailB]);

  const adminEmail = `admin-analytics-admin-${suffix}@device.fieldready.internal`;
  const adminPassword = 'admin-analytics-proof-admin-password-123';
  const adminAuthId = await createAuthUser(adminEmail, adminPassword);
  const adminRow = await db.query(`insert into platform_admin (auth_user_id, full_name) values ($1, 'Admin Proof') returning id`, [adminAuthId]);
  createdPlatformAdminIds.push(adminRow.rows[0].id);

  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantAId]);
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantBId]);

  const jobA = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, 'JOB-A', 'Job A', 'instalacao', 4, 100, 'dispatched') returning id`,
    [tenantAId, clientA.rows[0].id]
  );
  const jobB = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, 'JOB-B', 'Job B', 'instalacao', 6, 200, 'closed') returning id`,
    [tenantBId, clientB.rows[0].id]
  );

  ok('fixtures: 2 tenants, 2 office users, 1 platform admin, 1 job each');

  const tokenA = await signIn(emailA, password);
  const tokenB = await signIn(emailB, password);
  const adminToken = await signIn(adminEmail, adminPassword);

  // ---- 1. Regression: tenant A still only sees its own job -----------------
  {
    const r = await pg('GET', `/job?tenant_id=eq.${tenantAId}&select=id`, tokenA);
    const rOther = await pg('GET', `/job?tenant_id=eq.${tenantBId}&select=id`, tokenA);
    if (r.status === 200 && r.json.length === 1 && rOther.status === 200 && rOther.json.length === 0) {
      ok('tenant A sees its own job, not tenant B\'s (tenant_isolation policy unaffected by the new additive admin policy)');
    } else fail('tenant isolation regression', { r, rOther });
  }

  // ---- 2. Platform admin sees BOTH tenants' jobs via the additive policy ---
  {
    const r = await pg('GET', `/job?id=in.(${jobA.rows[0].id},${jobB.rows[0].id})&select=id,tenant_id,status`, adminToken);
    const ids = (r.json ?? []).map((j) => j.id);
    if (r.status === 200 && ids.includes(jobA.rows[0].id) && ids.includes(jobB.rows[0].id)) {
      ok('platform admin sees both tenant A\'s and tenant B\'s jobs via job_platform_admin_read');
    } else fail('admin cross-tenant job read', r);
  }

  // ---- 3. Platform admin's read is read-only: no write policy exists -------
  {
    const r = await pg('PATCH', `/job?id=eq.${jobA.rows[0].id}`, adminToken, { status: 'cancelled' });
    const check = await db.query(`select status from job where id = $1`, [jobA.rows[0].id]);
    if ((r.status === 200 && (!r.json || r.json.length === 0)) && check.rows[0].status === 'dispatched') {
      ok('platform admin cannot write to a tenant\'s job (no matching write policy — read-only by design, status unchanged)');
    } else fail('admin job write blocked', { r, actual: check.rows[0] });
  }

  // ---- 4. Office B still cannot see tenant A's job via the admin path ------
  {
    const r = await pg('GET', `/job?id=eq.${jobA.rows[0].id}`, tokenB);
    if (r.status === 200 && r.json.length === 0) ok('office B (a plain tenant, not an admin) still cannot see tenant A\'s job');
    else fail('non-admin cross-tenant read stays blocked', r);
  }

  console.log(`\n${failures === 0 ? 'All' : failures + ' of the'} admin-analytics-proof.mjs checks ${failures === 0 ? 'passed' : 'FAILED'}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
