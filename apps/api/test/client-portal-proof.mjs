// Proof for the client-facing portal (product improvement): office
// generates a link (rpc_job_generate_client_link), an ANONYMOUS visitor
// (no Supabase session at all — the real-world case) resolves it
// (fn_track_job) and fetches a real photo (routes/track.ts), and none of
// that leaks a wrong token or a different job's photo.
//
// Same shape as photo-upload-real-job-proof.mjs: a real tenant/office/
// technician/device via the real create->pair->sign-in chain, a real job,
// a real multipart photo upload — then the portal flow on top of that
// already-real data.
//
// Usage: node --env-file=.env test/client-portal-proof.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_client_portal";
const PORT = 3920;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "client-portal-proof-fixed-secret";

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

const restBase = `https://${projectRef}.supabase.co/rest/v1`;
// Anonymous PostgREST call — no bearer token beyond the anon apikey
// itself, the exact same shape a real, session-less visitor's browser
// would send. Deliberately NOT reusing a helper that defaults to a
// bearer token, since "no session at all" is the entire point being
// proven here.
async function anonRpc(fn, args) {
  const res = await fetch(`${restBase}/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json() };
}
async function bearerRpc(token, fn, args) {
  const res = await fetch(`${restBase}/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json() };
}
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
async function uploadPhotoBearer(jobId, token, phase) {
  const form = new FormData();
  form.append("phase", phase);
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "photo.png");
  const res = await fetch(`${BASE}/jobs/${jobId}/photos`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, json: await res.json() };
}
// A GET that reads the raw response (not JSON) — for fetching photo
// bytes through routes/track.ts, the anonymous, token-gated route.
async function getBytes(p) {
  const res = await fetch(BASE + p);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type"), buffer };
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
function killServerHard() {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.killed) return resolve();
    serverProc.once("exit", () => resolve());
    serverProc.kill("SIGKILL");
  });
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
async function cleanupFixtures() {
  async function step(label, fn) { try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); } }
  if (createdTenantIds.length > 0) {
    await step("delete job_photo", () => db.query(`delete from job_photo where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job", () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete client", () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete technician_device", () => db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete app_user", () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
  if (createdTenantIds.length > 0) await step("delete tenant", () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);
  const tenant = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id`,
    [`Client Portal Proof ${suffix}`, `client-portal-proof-${suffix}`]);
  const tenantId = tenant.rows[0].id;
  createdTenantIds.push(tenantId);

  const officeEmail = `client-portal-office-${suffix}@device.fieldready.internal`;
  const officePassword = "client-portal-proof-office-password-123";
  const officeAuthId = await createAuthUser(officeEmail, officePassword);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office', $3)`, [officeAuthId, tenantId, officeEmail]);
  const client = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente Portal Proof') returning id`, [tenantId]);

  const officeToken = await signIn(officeEmail, officePassword);

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (client-portal proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  let technicianId, deviceToken;
  {
    const r = await bearerRpc(officeToken, "rpc_technician_create", { p_full_name: "Técnico Portal Proof" });
    if (r.status === 200 && r.json?.kind === "ok") { technicianId = r.json.id; ok("rpc_technician_create succeeds"); }
    else { fail("rpc_technician_create", r); throw new Error("cannot continue"); }
  }
  {
    const pin = "5521";
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, officeToken, { device_label: "Portal Proof phone", pin });
    if (r.status === 201 && r.json?.device_id) {
      const deviceEmail = `${r.json.device_id}@device.fieldready.internal`;
      const row = await db.query(`select auth_user_id from technician_device where id = $1`, [r.json.device_id]);
      createdAuthUserIds.push(row.rows[0].auth_user_id);
      deviceToken = await signIn(deviceEmail, pin);
      ok("real create -> pair -> sign-in chain succeeds");
    } else { fail("real pairing succeeds", r); throw new Error("cannot continue"); }
  }

  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to, scheduled_at)
     values ($1, $2, $3, 'Client portal proof job', 'TDT novo', 2, 30, 'in_progress', $4, now())
     returning id;`,
    [tenantId, client.rows[0].id, `PORTAL-${suffix}`, technicianId]
  );
  const jobId = job.rows[0].id;

  // A second, unrelated job (different tenant) with its own photo, purely
  // to prove the token-gated photo route can't be used to enumerate other
  // jobs' photos by id alone.
  const otherTenant = await db.query(`insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
    [`Client Portal Proof Other ${suffix}`, `client-portal-proof-other-${suffix}`]);
  createdTenantIds.push(otherTenant.rows[0].id);
  const otherClient = await db.query(`insert into client (tenant_id, name) values ($1, 'Outro Cliente') returning id`, [otherTenant.rows[0].id]);
  const otherJob = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, $3, 'Other job', 'TDT novo', 1, 10, 'dispatched') returning id;`,
    [otherTenant.rows[0].id, otherClient.rows[0].id, `PORTAL-OTHER-${suffix}`]
  );
  const otherPhoto = await db.query(
    `insert into job_photo (tenant_id, job_id, phase, file) values ($1, $2, 'before', 'nonexistent-key') returning id;`,
    [otherTenant.rows[0].id, otherJob.rows[0].id]
  );

  ok("fixtures: 2 tenants, real technician chain, 1 real job (in_progress), 1 unrelated job+photo in a different tenant");

  // ---- 1. Office generates the link ----------------------------------------
  let token;
  {
    const r = await bearerRpc(officeToken, "rpc_job_generate_client_link", { p_job_id: jobId });
    if (r.status === 200 && r.json?.kind === "ok" && r.json.token) { token = r.json.token; ok("rpc_job_generate_client_link generates a real token"); }
    else { fail("rpc_job_generate_client_link generates a token", r); throw new Error("cannot continue"); }
  }
  // ---- 2. Calling it again returns the SAME token (coalesce, no re-roll) --
  {
    const r = await bearerRpc(officeToken, "rpc_job_generate_client_link", { p_job_id: jobId });
    if (r.status === 200 && r.json?.token === token) ok("calling rpc_job_generate_client_link again returns the SAME token, not a new one");
    else fail("second call returns the same token", r);
  }

  // ---- 3. A real technician uploads a real photo to the job ---------------
  let photoId;
  {
    const r = await uploadPhotoBearer(jobId, deviceToken, "during");
    if (r.status === 200 && r.json?.id) { photoId = r.json.id; ok("real photo upload succeeds against the real job"); }
    else { fail("photo upload succeeds", r); throw new Error("cannot continue"); }
  }

  // ---- 4. An ANONYMOUS visitor (no bearer token, no session at all) -------
  // ----    resolves the token via fn_track_job ------------------------------
  {
    const r = await anonRpc("fn_track_job", { p_token: token });
    if (
      r.status === 200 &&
      r.json?.kind === "ok" &&
      r.json.code === `PORTAL-${suffix}` &&
      r.json.status === "in_progress" &&
      Array.isArray(r.json.photos) &&
      r.json.photos.length === 1 &&
      r.json.photos[0].id === photoId &&
      r.json.photos[0].phase === "during"
    ) {
      ok("fn_track_job (anon, no session at all) resolves the real token to the real job's status + photo metadata");
    } else fail("fn_track_job resolves correctly for an anonymous caller", r);
  }
  // ---- 5. A wrong/random token resolves to not_found, not an error --------
  {
    const r = await anonRpc("fn_track_job", { p_token: "00000000-0000-0000-0000-000000000000" });
    if (r.status === 200 && r.json?.kind === "not_found") ok("fn_track_job: a random/wrong token resolves to not_found cleanly");
    else fail("wrong token resolves to not_found", r);
  }

  // ---- 6. The anonymous, token-gated photo-bytes route ---------------------
  {
    const r = await getBytes(`/track/${token}/photos/${photoId}`);
    if (r.status === 200 && r.contentType === "image/png" && r.buffer.length > 0) {
      ok(`GET /track/:token/photos/:photoId (anonymous, no auth header at all) returns the real photo bytes (content-type=${r.contentType}, ${r.buffer.length} bytes)`);
    } else fail("photo bytes route returns the real file", { status: r.status, contentType: r.contentType, len: r.buffer.length });
  }
  // ---- 7. The right token + a DIFFERENT job's photo id -> not found -------
  // ----    (no cross-job enumeration via photo id alone) --------------------
  {
    const r = await getBytes(`/track/${token}/photos/${otherPhoto.rows[0].id}`);
    if (r.status === 404) ok("GET /track/:token/photos/:photoId rejects a real photo id that belongs to a DIFFERENT job (no enumeration)");
    else fail("cross-job photo id rejected", r);
  }
  // ---- 8. A wrong token + the right photo id -> not found ------------------
  {
    const r = await getBytes(`/track/00000000-0000-0000-0000-000000000000/photos/${photoId}`);
    if (r.status === 404) ok("GET /track/:token/photos/:photoId rejects a wrong token even with a real photo id");
    else fail("wrong token rejected", r);
  }
  // ---- 9. A malformed (non-uuid) token/photoId 404s cleanly, not a 500 ----
  {
    const r = await getBytes(`/track/not-a-uuid/photos/also-not-a-uuid`);
    if (r.status === 404) ok("GET /track/:token/photos/:photoId: a malformed, non-uuid path 404s cleanly (not a raw Postgres type-cast 500)");
    else fail("malformed token/photoId 404s cleanly", r);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} client-portal-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await killServerHard();
  await cleanupFixtures();
  await db.end();
}
