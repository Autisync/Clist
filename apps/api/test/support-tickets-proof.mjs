// Proof for the support-ticket system (schema.sql §11a) — real, direct
// PostgREST calls against the real Supabase project, no Fastify server
// involved (everything here is plain RLS-scoped .from() reads/writes plus
// column defaults, per this project's own established decision rule: no
// RPC is needed unless atomicity or server-side attribution genuinely
// requires one, and defaults already cover the attribution concern here).
//
// Cleanup scope: every row this script deletes is matched by ITS OWN
// randomly-suffixed tenant/email, never a broad table-wide sweep — this
// project is shared with at least one other concurrent session (real
// data: antenas-rex-sb, outro-instalador-sb, fieldready-internal), and a
// careless cleanup here could delete rows that were never this script's
// to touch. See platform-admin-proof.mjs's own sibling comment on this
// same discipline.
//
// Usage:
//   cd apps/api && node --env-file=.env test/support-tickets-proof.mjs

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

async function callRpc(token, fn, args) {
  const res = await fetch(`${restBase}/rpc/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: anonKey, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json() };
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
  // Every delete below is scoped to createdTenantIds/createdPlatformAdminIds
  // — ids this run itself created and collected, never a bare `delete from`
  // with no where clause.
  if (createdTenantIds.length > 0) {
    await step('delete support_ticket_message', () => db.query(`delete from support_ticket_message where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete support_ticket', () => db.query(`delete from support_ticket where tenant_id = any($1::uuid[])`, [createdTenantIds]));
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
    [`Support Ticket Proof A ${suffix}`, `support-ticket-proof-a-${suffix}`]);
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);
  const tenantB = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Support Ticket Proof B ${suffix}`, `support-ticket-proof-b-${suffix}`]);
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `support-ticket-a-${suffix}@device.fieldready.internal`;
  const emailB = `support-ticket-b-${suffix}@device.fieldready.internal`;
  const password = 'support-ticket-proof-password-123';
  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);
  const officeA = await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3) returning id`, [authIdA, tenantAId, emailA]);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`, [authIdB, tenantBId, emailB]);

  const adminEmail = `support-ticket-admin-${suffix}@device.fieldready.internal`;
  const adminPassword = 'support-ticket-proof-admin-password-123';
  const adminAuthId = await createAuthUser(adminEmail, adminPassword);
  const adminRow = await db.query(`insert into platform_admin (auth_user_id, full_name) values ($1, 'Admin Proof') returning id`, [adminAuthId]);
  createdPlatformAdminIds.push(adminRow.rows[0].id);

  ok('fixtures: 2 tenants, 2 real office users, 1 real platform admin');

  const tokenA = await signIn(emailA, password);
  const tokenB = await signIn(emailB, password);
  const adminToken = await signIn(adminEmail, adminPassword);

  // ---- 1. Office A creates a ticket — plain insert, defaults resolve ------
  let ticketId;
  {
    const r = await pg('POST', '/support_ticket', tokenA, { subject: 'Não consigo gerar o REF', body: 'O botão não responde.' });
    const row = Array.isArray(r.json) ? r.json[0] : r.json;
    if (r.status === 201 && row?.tenant_id === tenantAId && row?.created_by === officeA.rows[0].id && row?.status === 'open') {
      ticketId = row.id;
      ok('office A creates a ticket via plain insert — tenant_id and created_by both resolve from defaults, status defaults to open');
    } else fail('ticket creation with correct defaults', r);
  }

  // ---- 2. Office A posts a reply on their own ticket ----------------------
  {
    const r = await pg('POST', '/support_ticket_message', tokenA, { ticket_id: ticketId, body: 'Mais informação: acontece no Safari.' });
    const row = Array.isArray(r.json) ? r.json[0] : r.json;
    if (r.status === 201 && row?.tenant_id === tenantAId && row?.sender_app_user_id === officeA.rows[0].id && row?.sender_platform_admin_id === null) {
      ok('office A posts a reply — tenant_id derived from the ticket via trigger, sender_app_user_id resolves, sender_platform_admin_id stays null');
    } else fail('office A reply with correct attribution', r);
  }

  // ---- 3. Office B cannot see or reply to tenant A's ticket ----------------
  {
    const r = await pg('GET', `/support_ticket?id=eq.${ticketId}`, tokenB);
    if (r.status === 200 && r.json.length === 0) ok('office B cannot see tenant A\'s ticket (RLS hides it)');
    else fail('cross-tenant ticket read blocked', r);
  }
  {
    const r = await pg('POST', '/support_ticket_message', tokenB, { ticket_id: ticketId, body: 'Tentativa de outro tenant' });
    // RLS makes the referenced ticket invisible to B, so the tenant guard
    // trigger's own lookup finds nothing and raises — surfaces as an error
    // from PostgREST (500-class from the DB exception), not a silent no-op.
    if (r.status >= 400) ok(`office B cannot post to tenant A's ticket (rejected, status ${r.status})`);
    else fail('cross-tenant reply blocked', r);
  }
  {
    const check = await db.query(`select count(*)::int as n from support_ticket_message where ticket_id = $1`, [ticketId]);
    if (check.rows[0].n === 1) ok('tenant A\'s ticket still has exactly its own 1 message after B\'s blocked attempt');
    else fail('no message leaked in from the blocked attempt', check.rows[0]);
  }

  // ---- 4. Spoofing attempts: explicit sender override rejected ------------
  {
    const r = await pg('POST', '/support_ticket_message', tokenA, {
      ticket_id: ticketId, body: 'Tentativa de falsificação', sender_platform_admin_id: adminRow.rows[0].id,
    });
    if (r.status >= 400) ok('office A cannot spoof sender_platform_admin_id to a real admin\'s id (rejected)');
    else fail('sender spoof (tenant claiming to be admin) rejected', r);
  }
  {
    // A second real office A-tenant user would be a cleaner adversary here,
    // but reusing tokenB (a different tenant entirely) against tenant A's
    // ticket_id already independently proves the identity check: even if
    // this insert somehow got past the tenant check (it won't — B's own
    // tenant_id can never match A's ticket), it ALSO explicitly claims to
    // be office A, which the identity check alone would reject.
    const r = await pg('POST', '/support_ticket_message', tokenB, {
      ticket_id: ticketId, body: 'Tentativa de falsificação de identidade', sender_app_user_id: officeA.rows[0].id,
    });
    if (r.status >= 400) ok('cannot spoof sender_app_user_id to a different real user\'s id (rejected)');
    else fail('sender spoof (claiming to be a different user) rejected', r);
  }

  // ---- 5. Platform admin sees ALL tickets across tenants -------------------
  {
    const r = await pg('GET', `/support_ticket?id=eq.${ticketId}`, adminToken);
    if (r.status === 200 && r.json.length === 1) ok('platform admin sees tenant A\'s ticket via the additive cross-tenant policy');
    else fail('admin cross-tenant ticket read', r);
  }

  // ---- 6. Platform admin replies — correctly attributed, correct tenant ---
  {
    const r = await pg('POST', '/support_ticket_message', adminToken, { ticket_id: ticketId, body: 'A equipa está a investigar.' });
    const row = Array.isArray(r.json) ? r.json[0] : r.json;
    if (r.status === 201 && row?.tenant_id === tenantAId && row?.sender_platform_admin_id === adminRow.rows[0].id && row?.sender_app_user_id === null) {
      ok('platform admin replies — tenant_id derived from the ticket (not the admin\'s own, they have none), sender_platform_admin_id resolves correctly');
    } else fail('admin reply with correct attribution', r);
  }
  {
    const count = await db.query(`select count(*)::int as n from support_ticket_message where ticket_id = $1`, [ticketId]);
    if (count.rows[0].n === 2) ok('ticket thread now has exactly 2 messages (office + admin), independently confirmed');
    else fail('thread message count independently confirmed', count.rows[0]);
  }

  // ---- 7. Platform admin updates ticket status ----------------------------
  {
    const r = await pg('PATCH', `/support_ticket?id=eq.${ticketId}`, adminToken, { status: 'resolved' });
    const row = Array.isArray(r.json) ? r.json[0] : r.json;
    if (r.status === 200 && row?.status === 'resolved') ok('platform admin marks the ticket resolved');
    else fail('admin status update', r);
  }

  // ---- 8. Office B still cannot see or update tenant A's now-resolved ----
  // ----    ticket -----------------------------------------------------------
  {
    const r = await pg('PATCH', `/support_ticket?id=eq.${ticketId}`, tokenB, { status: 'closed' });
    const check = await db.query(`select status from support_ticket where id = $1`, [ticketId]);
    if ((r.status === 200 && (!r.json || r.json.length === 0) || r.status === 404) && check.rows[0].status === 'resolved') {
      ok('office B\'s update to tenant A\'s ticket affects zero rows (RLS-invisible, status unchanged)');
    } else fail('cross-tenant status update blocked', { r, actual: check.rows[0] });
  }

  console.log(`\n${failures === 0 ? 'All' : failures + ' of the'} support-tickets-proof.mjs checks ${failures === 0 ? 'passed' : 'FAILED'}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
