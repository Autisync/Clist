// Proof that GET /jobs/:id/pickup-plan works for a REAL, Supabase-native
// job — the specific piece item 8 (the phone client's disabled pickup-plan
// suggestion card) was missing even after suppliers/catalog/pricing were
// reconnected to real data (see routes/suppliers.ts's own "found and
// fixed" comment from that slice). routes/jobs.ts's pickup-plan route now
// tries public.job first and only falls back to the classic schema's own
// job table — phase4-proof.mjs already proves the classic-fallback branch
// exhaustively (its own pickup-plan fixture); this script exists
// specifically to prove the REAL branch, which nothing else exercises.
//
// Same shape as field-flow-proof.mjs: a real tenant/office/technician/
// device via the real create->pair->sign-in chain, a real job (direct
// insert, matching field-flow-proof.mjs's own "not re-testing job
// creation here" reasoning), and — new for this script — a real
// supplier/catalog_item/supplier_price fixture so the pickup-plan's
// coverage/open-now/price ranking has something real to rank.
//
// Usage: node --env-file=.env test/pickup-plan-real-job-proof.mjs

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_pickup_plan_real";
const PORT = 3918;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "pickup-plan-real-job-proof-fixed-secret";

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
    await step("delete job_checklist_item", () => db.query(`delete from job_checklist_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job", () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete client", () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete supplier_price", () => db.query(`delete from supplier_price where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete supplier", () => db.query(`delete from supplier where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete catalog_item", () => db.query(`delete from catalog_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
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
    [`Pickup Plan Real Job Proof ${suffix}`, `pickup-plan-real-job-proof-${suffix}`]);
  const tenantId = tenant.rows[0].id;
  createdTenantIds.push(tenantId);

  const officeEmail = `pickup-plan-real-office-${suffix}@device.fieldready.internal`;
  const officePassword = "pickup-plan-real-proof-office-password-123";
  const officeAuthId = await createAuthUser(officeEmail, officePassword);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office', $3)`, [officeAuthId, tenantId, officeEmail]);
  const client = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente Pickup Plan Real') returning id`, [tenantId]);

  // Real supplier/catalog/price fixture — two suppliers, one open now and
  // cheaper, one closed and more expensive, so the (coverage, open-now,
  // price) tuple genuinely has something to rank, same fixture shape
  // phase4-proof.mjs's own pickup-plan section already uses.
  const catalogItem = await db.query(`insert into catalog_item (tenant_id, sku, name) values ($1, 'PICKUP-REAL-001', 'Peça Pickup Real') returning id`, [tenantId]);
  const itemId = catalogItem.rows[0].id;
  const now = new Date();
  const dow = now.getDay();
  const openHours = [null, null, null, null, null, null, null];
  openHours[dow] = { dow, open: "00:00", close: "23:59" };
  const closedHours = [null, null, null, null, null, null, null];
  const supOpen = await db.query(`insert into supplier (tenant_id, name, hours) values ($1, 'Fornecedor Aberto Real', $2) returning id`, [tenantId, JSON.stringify(openHours)]);
  const supClosed = await db.query(`insert into supplier (tenant_id, name, hours) values ($1, 'Fornecedor Fechado Real', $2) returning id`, [tenantId, JSON.stringify(closedHours)]);
  await db.query(`insert into supplier_price (tenant_id, supplier_id, item_id, price, source) values ($1, $2, $3, 3.50, 'manual')`, [tenantId, supOpen.rows[0].id, itemId]);
  await db.query(`insert into supplier_price (tenant_id, supplier_id, item_id, price, source) values ($1, $2, $3, 1.00, 'manual')`, [tenantId, supClosed.rows[0].id, itemId]);
  ok("fixtures: 1 tenant, 1 office user, 1 client, 1 catalog item, 2 suppliers (1 open/pricier, 1 closed/cheaper), 2 prices");

  const officeToken = await signIn(officeEmail, officePassword);

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (pickup-plan real-job proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  // Real create -> pair -> sign-in chain, same as field-flow-proof.mjs.
  let technicianId;
  {
    const r = await callRpc(officeToken, "rpc_technician_create", { p_full_name: "Técnico Pickup Plan Real" });
    if (r.status === 200 && r.json?.kind === "ok") { technicianId = r.json.id; ok("rpc_technician_create succeeds"); }
    else { fail("rpc_technician_create", r); throw new Error("cannot continue"); }
  }
  let deviceToken;
  const pin = "4127";
  {
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, officeToken, { device_label: "Pickup Plan Real phone", pin });
    if (r.status === 201 && r.json?.device_id) {
      const deviceEmail = `${r.json.device_id}@device.fieldready.internal`;
      const row = await db.query(`select auth_user_id from technician_device where id = $1`, [r.json.device_id]);
      createdAuthUserIds.push(row.rows[0].auth_user_id);
      deviceToken = await signIn(deviceEmail, pin);
      ok("real create -> pair -> sign-in chain succeeds");
    } else { fail("real pairing succeeds", r); throw new Error("cannot continue"); }
  }

  // The real job itself — public.job, not the classic system's own copy —
  // with a checklist item that has a real item_id and status='missing',
  // exactly the shape routes/jobs.ts's missingItemsFor() looks for.
  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to)
     values ($1, $2, $3, 'Pickup plan real job', 'Reposição de material avulso', 2, 20, 'dispatched', $4)
     returning id;`,
    [tenantId, client.rows[0].id, `PICKUPREAL-${suffix}`, technicianId]
  );
  const jobId = job.rows[0].id;
  await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, qty, item_id, scope, mandatory, status)
     values ($1, $2, 'material', 'Peça Pickup Real', 2, $3, 'job', true, 'missing');`,
    [tenantId, jobId, itemId]
  );
  ok("fixture job created: a REAL public.job (not the classic schema's own), assigned to the real technician, with a missing checklist item");

  // ---- The actual proof: GET /jobs/:id/pickup-plan against this real job -
  {
    const r = await callBearer("GET", `/jobs/${jobId}/pickup-plan`, deviceToken);
    if (r.status !== 200) { fail("GET /jobs/:id/pickup-plan returns 200 for a real job", r); }
    else {
      const plan = r.json?.plan ?? [];
      const names = plan.map((e) => e.supplier.name);
      if (
        plan.length === 2 &&
        names[0] === "Fornecedor Aberto Real" &&
        names[1] === "Fornecedor Fechado Real" &&
        plan[0].state.open === true &&
        plan[1].state.open === false &&
        plan[0].total === 7 && // 3.50 * qty 2
        plan[1].total === 2 // 1.00 * qty 2
      ) {
        ok("pickup-plan for a REAL Supabase-native job returns the correct ranking: open supplier first despite being pricier (coverage ties, open-now wins), totals correct (qty-weighted)");
      } else {
        fail("pickup-plan ranking correct for a real job", JSON.stringify(plan.map((e) => ({ name: e.supplier.name, open: e.state.open, total: e.total }))));
      }
    }
  }

  // ---- Regression: the technician role can call this (no office-only ----
  // ----  restriction on this route) ----------------------------------------
  {
    const r = await callBearer("GET", `/jobs/${jobId}/pickup-plan`, deviceToken);
    if (r.status === 200) ok("technician (not just office) can call pickup-plan for their own assigned job");
    else fail("technician can call pickup-plan", r);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} pickup-plan-real-job-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await killServerHard();
  await cleanupFixtures();
  await db.end();
}
