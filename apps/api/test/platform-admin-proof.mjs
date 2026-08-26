// Proof for the platform-admin identity model (schema.sql §2b) and tenant
// onboarding (routes/platform-admin.ts) — the admin-provisioned onboarding
// UI's backend. Exercised through the real, running HTTP API and the real
// Supabase project: a real platform_admin row (created the same way
// provision-platform-admin.mjs does), a real Supabase Auth sign-in, and a
// real POST /platform-admin/tenants call that creates a real tenant + a
// real Supabase Auth office user, the same sequence
// provision-tenant.mjs's own CLI flow already proved by hand.
//
// Usage: node --env-file=.env test/platform-admin-proof.mjs   (from apps/api)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema } from "./db-reset.mjs";

const FASTIFY_DB_SCHEMA = "fastify_api_proof_platform_admin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const PORT = 3916;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "platform-admin-proof-fixed-secret";

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error("Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.");
  process.exit(1);
}

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`); }

async function callBearer(method, p, token, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

async function callRpc(token, fn, args) {
  const res = await fetch(`https://${projectRef}.supabase.co/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function selectTenants(token) {
  const res = await fetch(`https://${projectRef}.supabase.co/rest/v1/tenant?select=id,slug`, {
    headers: { apikey: anonKey, authorization: `Bearer ${token}` },
  });
  return { status: res.status, json: await res.json() };
}

let serverProc = null;
function spawnServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", "tsx", "apps/api/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(PORT), SESSION_JWT_SECRET: JWT_SECRET, FASTIFY_DB_SCHEMA, LOG: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    proc.stdout.on("data", (d) => { if (!settled && d.toString().includes("listening on")) { settled = true; resolve(proc); } });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (code) => { if (!settled) reject(new Error(`server exited early with code ${code}`)); });
    setTimeout(() => { if (!settled) reject(new Error("server did not report ready in time")); }, 15000);
  });
}
async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const res = await fetch(`${BASE}/health`); if (res.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("/health never went green");
}

const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;
const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser } = createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds });
const db = new Client(pgClientConfig(projectRef, dbPassword));

async function signIn(email, password) {
  const res = await fetch(`${authApiBase}/token?grant_type=password`, {
    method: "POST", headers: { "content-type": "application/json", apikey: anonKey },
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
  if (createdPlatformAdminIds.length > 0) {
    await step("delete platform_admin", () => db.query(`delete from platform_admin where id = any($1::uuid[])`, [createdPlatformAdminIds]));
  }
  if (createdTenantIds.length > 0) {
    await step("delete app_user", () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete tenant", () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);

  // ---- fixture: 1 real platform admin, 1 regular (non-admin) office user
  const adminEmail = `platform-admin-proof-${suffix}@device.fieldready.internal`;
  const adminPassword = "platform-admin-proof-password-123";
  const adminAuthId = await createAuthUser(adminEmail, adminPassword);
  const adminRow = await db.query(`insert into platform_admin (auth_user_id, full_name) values ($1, 'Admin Proof') returning id`, [adminAuthId]);
  createdPlatformAdminIds.push(adminRow.rows[0].id);

  const regularTenant = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Platform Admin Proof Regular ${suffix}`, `platform-admin-proof-regular-${suffix}`]);
  createdTenantIds.push(regularTenant.rows[0].id);
  const regularEmail = `platform-admin-proof-regular-${suffix}@device.fieldready.internal`;
  const regularPassword = "platform-admin-proof-regular-password-123";
  const regularAuthId = await createAuthUser(regularEmail, regularPassword);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Regular Office', $3)`,
    [regularAuthId, regularTenant.rows[0].id, regularEmail]);

  ok("fixtures: 1 real platform admin, 1 regular (non-admin) tenant + office user");

  const adminToken = await signIn(adminEmail, adminPassword);
  const regularToken = await signIn(regularEmail, regularPassword);

  // ---- 1. fn_is_platform_admin() ------------------------------------------
  {
    const r = await callRpc(adminToken, "fn_is_platform_admin", {});
    if (r.status === 200 && r.json === true) ok("fn_is_platform_admin() returns true for the real platform admin");
    else fail("fn_is_platform_admin() true for admin", r);
  }
  {
    const r = await callRpc(regularToken, "fn_is_platform_admin", {});
    if (r.status === 200 && r.json === false) ok("fn_is_platform_admin() returns false for a regular office user");
    else fail("fn_is_platform_admin() false for regular user", r);
  }

  // ---- 2. platform_admin_read_all_tenants RLS policy, additive not -------
  // ----    replacing --------------------------------------------------------
  {
    const r = await selectTenants(adminToken);
    const sawRegular = r.json.some((t) => t.id === regularTenant.rows[0].id);
    if (r.status === 200 && r.json.length >= 2 && sawRegular) {
      ok(`platform admin sees multiple tenants via plain .from("tenant") (${r.json.length} visible, including the fixture regular tenant)`);
    } else fail("platform admin sees all tenants", r);
  }
  {
    const r = await selectTenants(regularToken);
    const onlyOwn = r.json.length === 1 && r.json[0].id === regularTenant.rows[0].id;
    if (r.status === 200 && onlyOwn) ok("regular office user still sees ONLY their own tenant (additive policy didn't loosen anything)");
    else fail("regular user tenant isolation unaffected", r);
  }

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (platform-admin proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  // ---- 3. No bearer token / garbage token / regular-user token all -------
  // ----    rejected --------------------------------------------------------
  {
    const r = await callBearer("POST", "/platform-admin/tenants", null, { tenant_name: "x", tenant_slug: "x", office_name: "x", office_email: "x@x.com", office_password: "x" });
    if (r.status === 401) ok("POST /platform-admin/tenants with no bearer token -> 401");
    else fail("no token rejected", r);
  }
  {
    const r = await callBearer("POST", "/platform-admin/tenants", "garbage-token", { tenant_name: "x", tenant_slug: "x", office_name: "x", office_email: "x@x.com", office_password: "x" });
    if (r.status === 401) ok("POST /platform-admin/tenants with a garbage bearer token -> 401");
    else fail("garbage token rejected", r);
  }
  {
    const r = await callBearer("POST", "/platform-admin/tenants", regularToken, { tenant_name: "x", tenant_slug: `x-${suffix}`, office_name: "x", office_email: `x-${suffix}@x.com`, office_password: "xxxxxxxx" });
    if (r.status === 403 && r.json?.error === "not_platform_admin") ok("POST /platform-admin/tenants as a regular (non-admin) office user -> 403 not_platform_admin");
    else fail("regular user rejected from platform-admin route", r);
  }

  // ---- 4. Real onboarding: a real platform admin creates a real tenant ---
  // ----    + a real Supabase Auth office user through the actual route ----
  let newTenantId, newOfficeUserId;
  const newOfficeEmail = `platform-admin-proof-onboarded-${suffix}@device.fieldready.internal`;
  {
    const r = await callBearer("POST", "/platform-admin/tenants", adminToken, {
      tenant_name: `Platform Admin Proof Onboarded ${suffix}`,
      tenant_slug: `platform-admin-proof-onboarded-${suffix}`,
      compliance_profile: "ited_ready",
      office_name: "Onboarded Office",
      office_email: newOfficeEmail,
      office_password: "onboarded-office-password-123",
    });
    if (r.status === 201 && r.json?.tenant_id && r.json?.office_user_id) {
      newTenantId = r.json.tenant_id;
      newOfficeUserId = r.json.office_user_id;
      createdTenantIds.push(newTenantId);
      ok("real onboarding: POST /platform-admin/tenants -> 201, real tenant + office user created");
    } else fail("real onboarding succeeds", r);
  }

  // ---- 5. Independently confirm, and the new office user can really sign -
  // ----    in and see only their own tenant --------------------------------
  {
    const row = await db.query(
      `select t.slug, t.compliance_profile, au.role, au.full_name, au.email
       from tenant t join app_user au on au.tenant_id = t.id
       where t.id = $1`,
      [newTenantId]
    );
    if (row.rows[0]?.role === "owner" && row.rows[0]?.email === newOfficeEmail && row.rows[0]?.compliance_profile === "ited_ready") {
      ok("independently confirmed: real tenant + owner app_user row, correct compliance_profile");
    } else fail("onboarding independently confirmed", row.rows[0]);
  }
  {
    const newOfficeToken = await signIn(newOfficeEmail, "onboarded-office-password-123");
    createdAuthUserIds.push((await db.query(`select auth_user_id from app_user where id = $1`, [newOfficeUserId])).rows[0].auth_user_id);
    const r = await selectTenants(newOfficeToken);
    const onlyOwn = r.status === 200 && r.json.length === 1 && r.json[0].id === newTenantId;
    if (onlyOwn) ok("the newly onboarded office user signs in for real and sees only their own new tenant");
    else fail("newly onboarded office user tenant isolation", r);
  }

  // ---- 6. Duplicate slug rejected, no dangling row left behind -----------
  {
    const r = await callBearer("POST", "/platform-admin/tenants", adminToken, {
      tenant_name: "Duplicate Slug Attempt",
      tenant_slug: `platform-admin-proof-onboarded-${suffix}`,
      office_name: "x", office_email: `dup-${suffix}@device.fieldready.internal`, office_password: "xxxxxxxx",
    });
    if (r.status === 409 && r.json?.error === "slug_taken") ok("duplicate tenant slug rejected with 409 slug_taken");
    else fail("duplicate slug rejected", r);
  }
  {
    const count = await db.query(`select count(*)::int as n from tenant where slug = $1`, [`platform-admin-proof-onboarded-${suffix}`]);
    if (count.rows[0].n === 1) ok("no duplicate/dangling tenant row from the rejected duplicate-slug attempt");
    else fail("no dangling tenant row", count.rows[0]);
  }

  // ---- 7. Office-email-already-in-use rejected, tenant rolled back -------
  {
    const r = await callBearer("POST", "/platform-admin/tenants", adminToken, {
      tenant_name: "Rollback Test",
      tenant_slug: `platform-admin-proof-rollback-${suffix}`,
      office_name: "x", office_email: newOfficeEmail, office_password: "xxxxxxxx",
    });
    if (r.status === 409 && r.json?.error === "office_email_taken") ok("re-using an already-registered office email rejected with 409 office_email_taken");
    else fail("duplicate office email rejected", r);
  }
  {
    const count = await db.query(`select count(*)::int as n from tenant where slug = $1`, [`platform-admin-proof-rollback-${suffix}`]);
    if (count.rows[0].n === 0) ok("tenant row correctly rolled back after the Auth user creation step failed");
    else fail("tenant rolled back on auth failure", count.rows[0]);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} platform-admin-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  if (serverProc) serverProc.kill("SIGKILL");
  await cleanupFixtures();
  await db.end();
}
