// Proof for the two per-technician dashboard views
// (v_first_time_fix_rate_by_technician, v_hours_variance_by_technician;
// schema.sql, applied live via apply-technician-analytics.mjs) — a real
// product improvement, not part of the original Phase 4 exit criterion.
// Real, direct PostgREST calls against the real Supabase project, same
// "no Fastify server needed for a plain RLS-scoped read" shape as
// admin-analytics-proof.mjs.
//
// Cleanup scope: every row this script deletes is matched by ITS OWN
// randomly-suffixed tenant ids, never a broad table-wide sweep — this
// project is shared with at least one other concurrent session.
//
// Usage:
//   cd apps/api && node --env-file=.env test/technician-analytics-proof.mjs

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
async function cleanupFixtures() {
  async function step(label, fn) { try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); } }
  if (createdTenantIds.length > 0) {
    await step('delete job_closeout', () => db.query(`delete from job_closeout where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job', () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete app_user', () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete tenant', () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Technician Analytics Proof A ${suffix}`, `technician-analytics-proof-a-${suffix}`]);
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);
  const tenantB = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Technician Analytics Proof B ${suffix}`, `technician-analytics-proof-b-${suffix}`]);
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `technician-analytics-a-${suffix}@device.fieldready.internal`;
  const emailB = `technician-analytics-b-${suffix}@device.fieldready.internal`;
  const password = 'technician-analytics-proof-password-123';
  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3)`, [authIdA, tenantAId, emailA]);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`, [authIdB, tenantBId, emailB]);

  // Tenant A: one technician, two closed jobs — 1 first-time-fix out of 2
  // (50%), hours delta (+1, +0) averaging +12.5% variance on a 4h quote,
  // same hand-computable fixture shape phase4-proof.mjs's own dashboard
  // section already established.
  const techA = await db.query(`insert into app_user (tenant_id, role, full_name) values ($1, 'technician', 'Ana Ferreira') returning id`, [tenantAId]);
  const techAId = techA.rows[0].id;
  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantAId]);
  const jobA1 = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to, actual_hours)
     values ($1, $2, 'TAP-A1', 'Job A1', 'Instalacao', 4, 50, 'closed', $3, 5) returning id;`,
    [tenantAId, clientA.rows[0].id, techAId]
  );
  const jobA2 = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to, actual_hours)
     values ($1, $2, 'TAP-A2', 'Job A2', 'Instalacao', 4, 50, 'closed', $3, 4) returning id;`,
    [tenantAId, clientA.rows[0].id, techAId]
  );
  await db.query(`insert into job_closeout (tenant_id, job_id, first_time_fix, closed_by, closed_at) values ($1, $2, true, $3, now())`, [tenantAId, jobA1.rows[0].id, techAId]);
  await db.query(`insert into job_closeout (tenant_id, job_id, first_time_fix, closed_by, closed_at) values ($1, $2, false, $3, now())`, [tenantAId, jobA2.rows[0].id, techAId]);

  // Tenant B: a different technician, one closed job — exists only to
  // prove tenant A's session can't see it.
  const techB = await db.query(`insert into app_user (tenant_id, role, full_name) values ($1, 'technician', 'Bruno Costa') returning id`, [tenantBId]);
  const techBId = techB.rows[0].id;
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente B') returning id`, [tenantBId]);
  const jobB1 = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to, actual_hours)
     values ($1, $2, 'TAP-B1', 'Job B1', 'Instalacao', 4, 50, 'closed', $3, 4) returning id;`,
    [tenantBId, clientB.rows[0].id, techBId]
  );
  await db.query(`insert into job_closeout (tenant_id, job_id, first_time_fix, closed_by, closed_at) values ($1, $2, true, $3, now())`, [tenantBId, jobB1.rows[0].id, techBId]);

  ok('fixtures: 2 tenants, 2 office users, 2 technicians, 3 closed jobs (2 for tech A, 1 for tech B)');

  const tokenA = await signIn(emailA, password);
  const tokenB = await signIn(emailB, password);

  // ---- 1. Tenant A's own numbers are correct ------------------------------
  {
    const r = await pg('GET', `/v_first_time_fix_rate_by_technician?technician_id=eq.${techAId}`, tokenA);
    const rows = r.json ?? [];
    const jobsClosed = rows.reduce((a, x) => a + Number(x.jobs_closed), 0);
    const firstTimeFixes = rows.reduce((a, x) => a + Number(x.first_time_fixes), 0);
    if (r.status === 200 && jobsClosed === 2 && firstTimeFixes === 1 && rows[0]?.technician_name === 'Ana Ferreira') {
      ok('v_first_time_fix_rate_by_technician: tenant A sees its own technician — jobs_closed=2, first_time_fixes=1, correct name');
    } else fail('v_first_time_fix_rate_by_technician correct for tenant A', { rows, jobsClosed, firstTimeFixes });
  }
  {
    const r = await pg('GET', `/v_hours_variance_by_technician?technician_id=eq.${techAId}`, tokenA);
    const row = (r.json ?? [])[0];
    if (r.status === 200 && row && Number(row.n) === 2 && Number(row.avg_hours_delta) === 0.5 && Math.abs(Number(row.avg_pct_variance) - 12.5) < 0.01) {
      ok(`v_hours_variance_by_technician: tenant A's technician shows n=2, avg_hours_delta=0.5, avg_pct_variance=12.5 (real, hand-computed values)`);
    } else fail('v_hours_variance_by_technician correct for tenant A', row);
  }

  // ---- 2. Tenant B cannot see tenant A's technician data (RLS via -------
  // ----    security_invoker on both views) --------------------------------
  {
    const r = await pg('GET', `/v_first_time_fix_rate_by_technician?technician_id=eq.${techAId}`, tokenB);
    if (r.status === 200 && (r.json ?? []).length === 0) {
      ok('v_first_time_fix_rate_by_technician: tenant B cannot see tenant A\'s technician (RLS-invisible)');
    } else fail('cross-tenant technician FFR read blocked', r);
  }
  {
    const r = await pg('GET', `/v_hours_variance_by_technician?technician_id=eq.${techAId}`, tokenB);
    if (r.status === 200 && (r.json ?? []).length === 0) {
      ok('v_hours_variance_by_technician: tenant B cannot see tenant A\'s technician (RLS-invisible)');
    } else fail('cross-tenant technician hours-variance read blocked', r);
  }
  // ---- 3. Tenant B sees its own technician's real data --------------------
  {
    const r = await pg('GET', `/v_first_time_fix_rate_by_technician?technician_id=eq.${techBId}`, tokenB);
    const rows = r.json ?? [];
    if (r.status === 200 && rows.length === 1 && Number(rows[0].jobs_closed) === 1 && rows[0].technician_name === 'Bruno Costa') {
      ok('v_first_time_fix_rate_by_technician: tenant B sees its own technician\'s real data');
    } else fail('tenant B own technician data correct', rows);
  }

  console.log(`\n${failures === 0 ? 'All' : failures + ' of the'} technician-analytics-proof.mjs checks ${failures === 0 ? 'passed' : 'FAILED'}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
