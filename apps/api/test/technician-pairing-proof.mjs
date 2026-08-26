// Proof for the technician-auth migration's pairing/revocation half
// (rpc_technician_create + POST /technicians/:id/pair + POST
// /technicians/devices/:id/revoke, routes/technicians.ts) —
// 08-supabase-native-migration.md §2. Exercised through the real, running
// HTTP API and the real Supabase project: a real office bearer token pairs
// a real device, the device signs in with its actual 4-digit PIN against
// real Supabase Auth (not a hand-crafted token), and the resulting session
// is proven against a still-Fastify route via the bridge (bridge-auth-
// proof.mjs's own sibling, this one covering pairing/revocation instead of
// pre-existing device rows).
//
// Usage: node --env-file=.env test/technician-pairing-proof.mjs   (from apps/api)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema, openDirectConnection } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_tech_pairing";
const PORT = 3914;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "tech-pairing-proof-fixed-secret";

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
  // content-type: application/json only when there IS a body -- Fastify's
  // JSON parser 500s on an empty body with that header set regardless of
  // method (apps/web/src/lib/api.ts's own matching comment on this exact
  // footgun; the revoke endpoint below takes no body, hit this for real).
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
  if (!res.ok) return { ok: false, status: res.status, body };
  return { ok: true, accessToken: body.access_token };
}

const createdTenantIds = [];
async function cleanupFixtures() {
  async function step(label, fn) { try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); } }
  if (createdTenantIds.length > 0) {
    await step("delete technician_device", () => db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete client", () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete app_user", () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
  if (createdTenantIds.length > 0) await step("delete tenant", () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);
  const tenantA = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Tech Pairing Proof A ${suffix}`, `tech-pairing-proof-a-${suffix}`]);
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);
  const tenantB = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Tech Pairing Proof B ${suffix}`, `tech-pairing-proof-b-${suffix}`]);
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `tech-pairing-a-${suffix}@device.fieldready.internal`;
  const emailB = `tech-pairing-b-${suffix}@device.fieldready.internal`;
  const password = "tech-pairing-proof-password-123";
  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3)`, [authIdA, tenantAId, emailA]);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`, [authIdB, tenantBId, emailB]);
  ok("fixtures: 2 tenants, 2 real office users");

  const tokenA = (await signIn(emailA, password)).accessToken;
  const tokenB = (await signIn(emailB, password)).accessToken;

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (technician-pairing proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");
  {
    const classicDb = await openDirectConnection(FASTIFY_DB_SCHEMA);
    try {
      await classicDb.query(`insert into tenant (id, name, slug, compliance_profile) values ($1, $2, $3, 'ited_ready')`,
        [tenantAId, `Tech Pairing Proof A ${suffix}`, `classic-tech-pairing-a-${suffix}`]);
    } finally { await classicDb.end(); }
  }

  // ---- 1. rpc_technician_create: office creates a technician -------------
  let technicianId;
  {
    const r = await callRpc(tokenA, "rpc_technician_create", { p_full_name: "Técnico Proof" });
    if (r.status === 200 && r.json?.kind === "ok" && r.json?.id) {
      technicianId = r.json.id;
      ok(`rpc_technician_create: office A creates a technician app_user (${r.json.full_name})`);
    } else fail("rpc_technician_create", r);
  }

  // ---- 2. technician role cannot create another technician ----------------
  // (proven already at the RPC layer in verify-ited-classification.mjs's
  // sibling role checks; not re-proven here — this file's job is pairing.)

  // ---- 3. office B cannot pair a device for office A's technician --------
  {
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, tokenB, { device_label: "Rogue phone", pin: "9999" });
    if (r.status === 404 && r.json?.error === "technician_not_found") {
      ok("POST /technicians/:id/pair as office B against office A's technician -> 404 technician_not_found (not a leak)");
    } else fail("cross-tenant pairing rejected", r);
  }

  // ---- 4. invalid pin shapes rejected -------------------------------------
  {
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, tokenA, { device_label: "Phone", pin: "12" });
    if (r.status === 400) ok("POST /technicians/:id/pair with a non-4-digit pin -> 400");
    else fail("non-4-digit pin rejected", r);
  }

  // ---- 5. real pairing: office A pairs a real device ----------------------
  let deviceId, deviceEmail;
  const pin = "4821";
  {
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, tokenA, { device_label: "Técnico Proof's phone", pin });
    if (r.status === 201 && r.json?.device_id) {
      deviceId = r.json.device_id;
      deviceEmail = `${deviceId}@device.fieldready.internal`;
      createdAuthUserIds.push(await db.query(`select auth_user_id from technician_device where id = $1`, [deviceId]).then((r2) => r2.rows[0].auth_user_id));
      ok(`POST /technicians/:id/pair -> 201, device_id=${deviceId}`);
    } else fail("real pairing succeeds", r);
  }

  // ---- 6. the device signs in for real, with its actual 4-digit PIN ------
  let deviceToken;
  {
    const signInResult = await signIn(deviceEmail, pin);
    if (signInResult.ok) {
      deviceToken = signInResult.accessToken;
      ok("the newly paired device signs in via real Supabase Auth with its actual 4-digit PIN");
    } else fail("device signs in with its PIN", signInResult);
  }

  // ---- 7. that session resolves through the bridge to the right tenant ---
  {
    const r = await callBearer("GET", "/clients", deviceToken);
    if (r.status === 200) ok("the paired device's session reaches a still-Fastify route via the bridge (200, correct tenant)");
    else fail("paired device reaches a still-Fastify route", r);
  }

  // ---- 8. technician role cannot revoke a device (office-only) -----------
  {
    const r = await callBearer("POST", `/technicians/devices/${deviceId}/revoke`, deviceToken);
    if (r.status === 403 && r.json?.error === "office_only") ok("technician cannot revoke a device -> 403 office_only");
    else fail("technician cannot self-revoke", r);
  }

  // ---- 9. office B cannot revoke office A's device ------------------------
  {
    const r = await callBearer("POST", `/technicians/devices/${deviceId}/revoke`, tokenB);
    if (r.status === 200 && r.json?.already_revoked_or_not_found) {
      ok("office B 'revoking' office A's device is a no-op (RLS-shaped not-found, not a cross-tenant leak)");
    } else fail("cross-tenant revoke is a no-op, not a leak", r);
  }
  {
    const stillActive = await db.query(`select revoked_at from technician_device where id = $1`, [deviceId]);
    if (stillActive.rows[0].revoked_at === null) ok("device is still NOT revoked after office B's no-op attempt");
    else fail("device unaffected by office B's attempt", stillActive.rows[0]);
  }

  // ---- 10. office A revokes it for real ------------------------------------
  {
    const r = await callBearer("POST", `/technicians/devices/${deviceId}/revoke`, tokenA);
    if (r.status === 200 && r.json?.ok === true && !r.json?.already_revoked_or_not_found) {
      ok("office A revokes its own tenant's device for real -> 200");
    } else fail("real revoke succeeds", r);
  }

  // ---- 11. the STILL-VALID access token issued before revocation is now --
  // ----     rejected by the bridge's revoked_at re-check -------------------
  {
    const r = await callBearer("GET", "/clients", deviceToken);
    if (r.status === 401) ok("the device's still-valid (unexpired) access token is now rejected by the bridge -> 401");
    else fail("revoked device's live token is rejected", r);
  }

  // ---- 12. the device can no longer sign in again at all (ban_duration) --
  {
    const signInResult = await signIn(deviceEmail, pin);
    if (!signInResult.ok && signInResult.status === 400) {
      ok(`revoked device can no longer sign in at all (${JSON.stringify(signInResult.body)})`);
    } else fail("revoked device cannot sign in again", signInResult);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} technician-pairing-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  if (serverProc) serverProc.kill("SIGKILL");
  await cleanupFixtures();
  await db.end();
}
