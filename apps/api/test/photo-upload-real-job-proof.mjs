// Proof that POST /jobs/:id/photos works for a REAL, Supabase-native job —
// a real, previously-shipped bug found while building the client-facing
// portal (needed to confirm how job photos actually get stored before
// designing what a client should be able to see): every real caller
// (field/jobs/[id]/tests + voice pages, office job-detail) uploads a photo
// against a real public.job id, but this route's DB access was still
// withTenant (the classic schema's own job/job_photo tables) — confirmed
// empirically before the fix (a real multipart upload against a real job,
// over HTTP, returned job_not_found every time), not assumed from reading
// the code. routes/jobs.ts now tries public.job first, falling back to
// the classic schema's own job table only if not found there — same
// dual-path shape that file's own pickup-plan route already established,
// for the same reason (phase2-proof.mjs's own classic dispatch-loop
// fixture needs the fallback branch to keep working, which it still does
// — confirmed separately by re-running that proof after this fix).
//
// Same shape as field-flow-proof.mjs / pickup-plan-real-job-proof.mjs: a
// real tenant/office/technician/device via the real create->pair->sign-in
// chain, a real job (direct insert, not re-testing job creation here).
//
// Usage: node --env-file=.env test/photo-upload-real-job-proof.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_photo_real_job";
const PORT = 3919;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "photo-upload-real-job-proof-fixed-secret";

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

async function callRpc(token, fn, args) {
  const res = await fetch(`https://${projectRef}.supabase.co/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  return { status: res.status, json };
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
  // A real (if trivial), valid 1x1 PNG — same fixture bytes this repo's
  // own phase2-proof.mjs already uses for its own classic-path photo test.
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  form.append("file", new Blob([pngBytes], { type: "image/png" }), "photo.png");
  const res = await fetch(`${BASE}/jobs/${jobId}/photos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
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
    [`Photo Upload Real Job Proof ${suffix}`, `photo-upload-real-job-proof-${suffix}`]);
  const tenantId = tenant.rows[0].id;
  createdTenantIds.push(tenantId);

  const officeEmail = `photo-real-office-${suffix}@device.fieldready.internal`;
  const officePassword = "photo-real-proof-office-password-123";
  const officeAuthId = await createAuthUser(officeEmail, officePassword);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office', $3)`, [officeAuthId, tenantId, officeEmail]);
  const client = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente Photo Real') returning id`, [tenantId]);

  const officeToken = await signIn(officeEmail, officePassword);

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (photo-upload real-job proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  let technicianId, deviceToken;
  {
    const r = await callRpc(officeToken, "rpc_technician_create", { p_full_name: "Técnico Photo Real" });
    if (r.status === 200 && r.json?.kind === "ok") { technicianId = r.json.id; ok("rpc_technician_create succeeds"); }
    else { fail("rpc_technician_create", r); throw new Error("cannot continue"); }
  }
  {
    const pin = "8843";
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, officeToken, { device_label: "Photo Real phone", pin });
    if (r.status === 201 && r.json?.device_id) {
      const deviceEmail = `${r.json.device_id}@device.fieldready.internal`;
      const row = await db.query(`select auth_user_id from technician_device where id = $1`, [r.json.device_id]);
      createdAuthUserIds.push(row.rows[0].auth_user_id);
      deviceToken = await signIn(deviceEmail, pin);
      ok("real create -> pair -> sign-in chain succeeds");
    } else { fail("real pairing succeeds", r); throw new Error("cannot continue"); }
  }

  // The real job — public.job, not the classic system's own copy.
  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to)
     values ($1, $2, $3, 'Photo upload real job', 'TDT novo', 2, 30, 'dispatched', $4)
     returning id;`,
    [tenantId, client.rows[0].id, `PHOTOREAL-${suffix}`, technicianId]
  );
  const jobId = job.rows[0].id;
  ok("fixture job created: a REAL public.job (not the classic schema's own), assigned to the real technician");

  // ---- The actual proof: a real multipart photo upload against this ----
  // ----  real job, as the real technician session ------------------------
  {
    const r = await uploadPhotoBearer(jobId, deviceToken, "before");
    if (r.status === 200 && r.json?.phase === "before" && r.json?.job_id === jobId) {
      ok("POST /jobs/:id/photos succeeds for a REAL Supabase-native job (this exact call 404'd before the fix)");
    } else fail("photo upload succeeds for a real job", r);
  }
  {
    const row = await db.query(`select id, job_id, phase, tenant_id, taken_by from job_photo where job_id = $1`, [jobId]);
    if (row.rows.length === 1 && row.rows[0].tenant_id === tenantId && row.rows[0].taken_by === technicianId) {
      ok("independently confirmed: the photo row landed in the REAL public.job_photo table, correctly attributed to the real technician");
    } else fail("photo row independently confirmed in public.job_photo", row.rows);
  }
  // ---- Regression: office (not just technician) can also upload --------
  {
    const r = await uploadPhotoBearer(jobId, officeToken, "evidence");
    if (r.status === 200 && r.json?.phase === "evidence") {
      ok("office session can also upload a photo to the same real job (job-detail.tsx's own real caller)");
    } else fail("office photo upload succeeds", r);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} photo-upload-real-job-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await killServerHard();
  await cleanupFixtures();
  await db.end();
}
