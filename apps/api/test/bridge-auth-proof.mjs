// Proof for the Supabase-bridge auth fix (auth/supabase-bridge.ts,
// auth/middleware.ts's requireAuth) — a real, previously-invisible gap
// found while designing the technician-auth migration: apps/web's office
// /login (§6 Step 5) signs in via Supabase Auth only and never sets
// fr_session at all, so every real production office user got a silent 401
// from every still-Fastify route (clients, photos, receipts, refresh-
// places, technician pairing) — nothing in this app's existing test suites
// exercised a Supabase-session-only caller against a still-Fastify route
// before this script.
//
// Exercised through the real, running HTTP API (same spawn-a-real-server
// pattern as test/phase1-proof.mjs), against the real Supabase project
// (same fixture pattern as apps/api/supabase/verify-*.mjs) — a bearer token
// from a genuine Supabase Auth sign-in, not a hand-crafted JWT, hitting a
// route that has never taken anything but an fr_session cookie until now.
//
// Usage: node --env-file=.env test/bridge-auth-proof.mjs   (from apps/api)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema, openDirectConnection } from "./db-reset.mjs";

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// rather than imported, same reasoning test/phase1-proof.mjs's own copy
// gives: this script has zero build step (plain Node, no tsx), so it can't
// import the .ts source directly.
const CLASSIC_OFFICE_A = { email: "rex@antenas-piloto.pt", password: "proof-pass-123" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_bridge_auth";
const PORT = 3913;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "bridge-auth-proof-fixed-secret";

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error(
    "Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.\n" +
    "Run as: cd apps/api && node --env-file=.env test/bridge-auth-proof.mjs"
  );
  process.exit(1);
}

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`); }

// ---- bearer-token HTTP client (no cookie jar at all — the whole point) ----

async function callBearer(method, p, token, body) {
  // content-type: application/json only when there IS a body -- Fastify's
  // JSON parser 500s on an empty body with that header set regardless of
  // method (apps/web/src/lib/api.ts's own matching comment on this exact
  // footgun) -- not hit by this script's own calls today (every POST here
  // has a body), fixed anyway so a future addition doesn't reintroduce it.
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ---- cookie-jar client, for the classic fr_session zero-regression check --

class CookieSession {
  cookie = null;
  async req(method, p, body) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length > 0) this.cookie = setCookie[0].split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json };
  }
  get(p) { return this.req("GET", p); }
  post(p, body) { return this.req("POST", p, body ?? {}); }
}

// ---- server process lifecycle (same pattern as test/phase1-proof.mjs) -----

let serverProc = null;

function spawnServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/index.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(PORT),
          SESSION_JWT_SECRET: JWT_SECRET,
          FASTIFY_DB_SCHEMA,
          LOG: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let settled = false;
    const onData = (d) => {
      if (!settled && d.toString().includes("listening on")) {
        settled = true;
        resolve(proc);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`server exited early with code ${code}`));
    });
    setTimeout(() => { if (!settled) reject(new Error("server did not report ready in time")); }, 15000);
  });
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("/health never went green");
}

// ---- Supabase-native fixtures ----------------------------------------------

const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;
const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser } = createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds });
const db = new Client(pgClientConfig(projectRef, dbPassword));

async function signIn(email, password) {
  const res = await fetch(`${authApiBase}/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body)}`);
  return body.access_token;
}

const createdTenantIds = [];

async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  if (createdTenantIds.length > 0) {
    await step("delete technician_device", () =>
      db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete client", () =>
      db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete app_user", () =>
      db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id));
  }
  if (createdTenantIds.length > 0) {
    await step("delete tenant", () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Bridge Auth Proof A ${suffix}`, `bridge-auth-proof-a-${suffix}`]
  );
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);

  const tenantB = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Bridge Auth Proof B ${suffix}`, `bridge-auth-proof-b-${suffix}`]
  );
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `bridge-auth-a-${suffix}@device.fieldready.internal`;
  const emailB = `bridge-auth-b-${suffix}@device.fieldready.internal`;
  const password = "bridge-auth-proof-password-123";
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

  // Technician: app_user row with NO auth_user_id (schema.sql's own comment
  // — "technician rows... have no login of their own, ever"), plus a
  // technician_device row carrying the real Supabase Auth link, paired to
  // tenant A. Not a 4-digit PIN here — proving the resolution mechanism,
  // not Supabase's password-length policy, which the real pairing endpoint
  // (not built yet) will have to reconcile separately.
  const technicianUser = await db.query(
    `insert into app_user (tenant_id, role, full_name) values ($1, 'technician', 'Técnico Proof') returning id`,
    [tenantAId]
  );
  const emailTech = `bridge-auth-tech-${suffix}@device.fieldready.internal`;
  const techPassword = "bridge-auth-proof-device-password-123";
  const authIdTech = await createAuthUser(emailTech, techPassword);
  const device = await db.query(
    `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by)
     values ($1, $2, 'Proof phone', $3, $4) returning id`,
    [tenantAId, technicianUser.rows[0].id, authIdTech, technicianUser.rows[0].id]
  );
  const deviceId = device.rows[0].id;

  ok("fixtures: 2 tenants, 2 office users, 1 technician + paired device (all real Supabase Auth users)");

  const tokenA = await signIn(emailA, password);
  const tokenB = await signIn(emailB, password);
  const tokenTech = await signIn(emailTech, techPassword);
  ok("all three real Supabase Auth sign-ins succeeded");

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);

  console.log("Starting API (bridge-auth proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  // The classic system's OWN client.tenant_id is FK-constrained to ITS OWN
  // tenant table (03-schema.sql), a completely separate table from the
  // Supabase-native public.tenant these fixtures live in (db.ts's own
  // header comment: "two genuinely separate table sets, one Postgres
  // server"). Bridge-resolved req.auth.tenant_id is a real Supabase-native
  // tenant id — for the classic system's own writes to succeed against it,
  // a matching classic-schema tenant row with the SAME id has to exist too.
  // This is a fixture-setup requirement of testing the classic system's
  // routes through the bridge, not something the bridge itself needs.
  {
    const classicDb = await openDirectConnection(FASTIFY_DB_SCHEMA);
    try {
      await classicDb.query(
        `insert into tenant (id, name, slug, compliance_profile) values ($1, $2, $3, 'ited_ready')`,
        [tenantAId, `Bridge Auth Proof A ${suffix}`, `classic-bridge-auth-proof-a-${suffix}`]
      );
      await classicDb.query(
        `insert into tenant (id, name, slug, compliance_profile) values ($1, $2, $3, 'ited_ready')`,
        [tenantBId, `Bridge Auth Proof B ${suffix}`, `classic-bridge-auth-proof-b-${suffix}`]
      );
    } finally {
      await classicDb.end();
    }
  }

  // ---- 1. No auth at all -> 401 ------------------------------------------
  {
    const r = await callBearer("GET", "/clients", null);
    if (r.status === 401) ok("GET /clients with no auth at all -> 401");
    else fail("GET /clients with no auth at all -> 401", r);
  }

  // ---- 2. Garbage bearer token -> 401 ------------------------------------
  {
    const r = await callBearer("GET", "/clients", "not-a-real-token");
    if (r.status === 401) ok("GET /clients with a garbage bearer token -> 401");
    else fail("GET /clients with a garbage bearer token -> 401", r);
  }

  // ---- 3. Real office session, bearer only, no cookie at all -------------
  let createdClientId = null;
  {
    const r = await callBearer("POST", "/clients", tokenA, { name: "Bridge Auth Proof Client" });
    if (r.status === 201 && r.json?.id) {
      createdClientId = r.json.id;
      ok("POST /clients with a real Supabase bearer token (office A, no cookie) -> 201");
    } else {
      fail("POST /clients with a real Supabase bearer token", r);
    }
  }

  // ---- 4. Office A sees its own client -----------------------------------
  {
    const r = await callBearer("GET", "/clients", tokenA);
    const found = r.json?.clients?.some((c) => c.id === createdClientId);
    if (r.status === 200 && found) ok("GET /clients as office A (bearer) sees the client it just created");
    else fail("GET /clients as office A sees its own client", r);
  }

  // ---- 5. Office B does NOT see tenant A's client (real tenant isolation,
  // ----    through the classic system's OWN RLS-equivalent, driven by the
  // ----    bridge-resolved tenant_id) -------------------------------------
  {
    const r = await callBearer("GET", "/clients", tokenB);
    const leaked = r.json?.clients?.some((c) => c.id === createdClientId);
    if (r.status === 200 && !leaked) ok("GET /clients as office B (bearer) does NOT see tenant A's client");
    else fail("GET /clients as office B does not see tenant A's client", r);
  }

  // ---- 6. Technician (device path, not app_user.auth_user_id) resolves to
  // ----    the SAME tenant A, sees the same client -------------------------
  {
    const r = await callBearer("GET", "/clients", tokenTech);
    const found = r.json?.clients?.some((c) => c.id === createdClientId);
    if (r.status === 200 && found) ok("GET /clients as the paired technician (device-path bearer) sees tenant A's client");
    else fail("GET /clients as the paired technician sees tenant A's client", r);
  }

  // ---- 7. Revoke the device, confirm the SAME still-valid access token now
  // ----    fails — proving revoked_at is re-checked on every request through
  // ----    the bridge too (08-supabase-native-migration.md §2's sharper edge),
  // ----    not just at sign-in ---------------------------------------------
  await db.query(`update technician_device set revoked_at = now() where id = $1`, [deviceId]);
  {
    const r = await callBearer("GET", "/clients", tokenTech);
    if (r.status === 401) ok("GET /clients with the revoked device's still-valid access token -> 401");
    else fail("revoked device's still-valid token is rejected", r);
  }

  // ---- 8. Zero-regression: the classic fr_session cookie path still works
  // ----    completely unchanged, side by side with the bridge -------------
  {
    const classic = new CookieSession();
    const login = await classic.post("/auth/office/login", CLASSIC_OFFICE_A);
    const list = await classic.get("/clients");
    if (login.status === 200 && list.status === 200) {
      ok("classic fr_session cookie login + GET /clients still works unchanged, alongside the new bridge");
    } else {
      fail("classic fr_session path still works unchanged", { login, list });
    }
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} bridge-auth-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  if (serverProc) serverProc.kill("SIGKILL");
  await cleanupFixtures();
  await db.end();
}
