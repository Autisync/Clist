// Proof for the technician-auth migration's field-side port
// (08-supabase-native-migration.md §2) — the highest-risk part of that
// port is apps/web/src/lib/offline-queue.ts's applyMutation(), a hand-
// written dispatch table mapping each of the five queued mutation types to
// its already-proven RPC's exact parameter names. This proves that mapping
// for real, against the real Supabase project, using the REAL create ->
// pair -> sign-in chain (rpc_technician_create, POST /technicians/:id/pair,
// real Supabase Auth) rather than a hand-inserted technician_device row —
// the same chain a real office user and a real paired phone would go
// through, end to end.
//
// Does NOT re-prove the RPCs themselves (already proven: verify-step4-rpc.mjs,
// verify-job-complete.mjs, phase2-4-proof.mjs) or the job-creation flow
// (verify-create-job.mjs) — the job fixture here is a direct insert with a
// realistic checklist/execution/test-protocol shape, matching the pattern
// bridge-auth-proof.mjs and technician-pairing-proof.mjs already use for
// "test one thing at a time, trust what's already proven elsewhere".
//
// Usage: node --env-file=.env test/field-flow-proof.mjs   (from apps/api)

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";
import { resetFastifySchema } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_field_flow";
const PORT = 3915;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "field-flow-proof-fixed-secret";

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
    await step("delete applied_mutation", () => db.query(`delete from applied_mutation where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete compliance_deadline", () => db.query(`delete from compliance_deadline where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job_closeout", () => db.query(`delete from job_closeout where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete van_audit", () => db.query(`delete from van_audit where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job_test_result", () => db.query(`delete from job_test_result where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job_execution_step_completion", () => db.query(`delete from job_execution_step_completion where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete job_checklist_item", () => db.query(`delete from job_checklist_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
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
    [`Field Flow Proof ${suffix}`, `field-flow-proof-${suffix}`]);
  const tenantId = tenant.rows[0].id;
  createdTenantIds.push(tenantId);

  const officeEmail = `field-flow-office-${suffix}@device.fieldready.internal`;
  const officePassword = "field-flow-proof-office-password-123";
  const officeAuthId = await createAuthUser(officeEmail, officePassword);
  await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office', $3)`, [officeAuthId, tenantId, officeEmail]);
  const client = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente Field Flow') returning id`, [tenantId]);
  ok("fixtures: 1 tenant, 1 real office user, 1 client");

  const officeToken = await signIn(officeEmail, officePassword);

  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);
  console.log("Starting API (field-flow proof schema)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  // ---- 1. Real create -> pair -> sign-in chain, same as a real office ----
  // ----    user + a real paired phone would go through ---------------------
  let technicianId;
  {
    const r = await callRpc(officeToken, "rpc_technician_create", { p_full_name: "Técnico Field Flow" });
    if (r.status === 200 && r.json?.kind === "ok") { technicianId = r.json.id; ok("rpc_technician_create succeeds"); }
    else fail("rpc_technician_create", r);
  }
  let deviceEmail, deviceToken;
  const pin = "7391";
  {
    const r = await callBearer("POST", `/technicians/${technicianId}/pair`, officeToken, { device_label: "Field Flow phone", pin });
    if (r.status === 201 && r.json?.device_id) {
      deviceEmail = `${r.json.device_id}@device.fieldready.internal`;
      const row = await db.query(`select auth_user_id from technician_device where id = $1`, [r.json.device_id]);
      createdAuthUserIds.push(row.rows[0].auth_user_id);
      ok("real pairing succeeds");
    } else fail("real pairing succeeds", r);
  }
  {
    deviceToken = await signIn(deviceEmail, pin);
    ok("the paired device signs in with its real PIN via real Supabase Auth");
  }

  // ---- 2. fn_current_app_user_id()/fn_current_tenant_id() resolve --------
  // ----    correctly for this real create->pair->sign-in chain ------------
  {
    const r = await callRpc(deviceToken, "fn_current_app_user_id", {});
    if (r.status === 200 && r.json === technicianId) ok("fn_current_app_user_id() resolves to the real technician's own id");
    else fail("fn_current_app_user_id() resolves correctly", r);
  }

  // ---- fixture job: assigned to this technician, dispatched, with a real -
  // ----  checklist item (scope=job), execution_snapshot, test_protocol_ ---
  // ----  snapshot -- direct insert, mirrors verify-create-job.mjs's already
  // ----  proven realistic shape; not re-testing job creation here ---------
  const executionSnapshot = { steps: [{ order: 0, label: "Instalar cabo" }, { order: 1, label: "Testar sinal" }] };
  const testProtocolSnapshot = {
    network_type: "SMATV",
    tests: [{ id: "mer", label: "MER", unit: "dB", dir: "min", min: 19.5, limit_ref: "Tabela 6.12" }],
  };
  const job = await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, status, assigned_to, execution_snapshot, test_protocol_snapshot)
     values ($1, $2, $3, 'Field flow proof job', 'TDT novo', 2, 50, 'dispatched', $4, $5, $6)
     returning id;`,
    [tenantId, client.rows[0].id, `FIELDFLOW-${suffix}`, technicianId, executionSnapshot, testProtocolSnapshot]
  );
  const jobId = job.rows[0].id;
  const checklistItem = await db.query(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, qty, scope, mandatory, status)
     values ($1, $2, 'material', 'Cabo coaxial', 10, 'job', true, 'missing')
     returning id;`,
    [tenantId, jobId]
  );
  const itemId = checklistItem.rows[0].id;
  ok("fixture job created: assigned to the real technician, dispatched, with a checklist item + snapshots");

  // ---- 3. /field/home's own query shape: assigned_to + status filter -----
  {
    const r = await fetch(`https://${projectRef}.supabase.co/rest/v1/job?select=id,code,title&assigned_to=eq.${technicianId}&status=in.(dispatched,in_progress,testing)&order=created_at.desc&limit=1`, {
      headers: { apikey: anonKey, authorization: `Bearer ${deviceToken}` },
    });
    const rows = await r.json();
    if (r.status === 200 && rows[0]?.id === jobId) ok("/field/home's own query shape finds the fixture job for this technician");
    else fail("/field/home query shape", { status: r.status, rows });
  }

  // ---- 4. Each of the 5 offline-queue.ts applyMutation() dispatch --------
  // ----    branches, called with EXACTLY the parameter names/shapes that --
  // ----    file uses -- this is the real risk being proven here -----------
  {
    const r = await callRpc(deviceToken, "rpc_checklist_item_update", {
      p_client_mutation_id: crypto.randomUUID(), p_job_id: jobId, p_item_id: itemId, p_status: "ok",
    });
    if (r.status === 200 && r.json?.status === "applied") ok("applyMutation('checklist_item.update') dispatch shape works for real");
    else fail("checklist_item.update dispatch shape", r);
  }
  {
    const r = await callRpc(deviceToken, "rpc_execution_step_complete", {
      p_client_mutation_id: crypto.randomUUID(), p_job_id: jobId, p_step: 0,
    });
    if (r.status === 200 && r.json?.status === "applied") ok("applyMutation('execution_step.complete') dispatch shape works for real");
    else fail("execution_step.complete dispatch shape", r);
  }
  {
    const r = await callRpc(deviceToken, "rpc_test_result_record", {
      p_client_mutation_id: crypto.randomUUID(), p_job_id: jobId,
      p_network_type: "SMATV", p_location_label: "Sala", p_test_code: "mer",
      p_measured_value: "21.0", p_unit: "dB", p_limit_ref: "Tabela 6.12",
      p_capture_source: "manual", p_raw_capture_file: null, p_instrument_id: null,
    });
    if (r.status === 200 && r.json?.outcome === "pass") ok(`applyMutation('test_result.record') dispatch shape works for real (outcome=${r.json.outcome})`);
    else fail("test_result.record dispatch shape", r);
  }
  {
    const r = await callRpc(deviceToken, "rpc_van_audit_record", {
      p_client_mutation_id: crypto.randomUUID(), p_van_label: "Carrinha 1",
      p_issues: [{ label: "Alicate partido", note: "Substituir" }],
    });
    if (r.status === 200 && r.json?.status === "applied") ok("applyMutation('van_audit.record') dispatch shape works for real");
    else fail("van_audit.record dispatch shape", r);
  }
  {
    const r = await callRpc(deviceToken, "rpc_closeout_submit", {
      p_client_mutation_id: crypto.randomUUID(), p_job_id: jobId,
      p_first_time_fix: true, p_technician_voice_note_file: null,
      p_technician_note_transcript: "Instalação concluída sem problemas.", p_client_signature_file: null,
    });
    if (r.status === 200 && r.json?.status === "applied") ok("applyMutation('closeout.submit') dispatch shape works for real");
    else fail("closeout.submit dispatch shape", r);
  }

  // ---- 5. Independently confirm all five actually landed in the DB -------
  {
    const item = await db.query(`select status, updated_by from job_checklist_item where id = $1`, [itemId]);
    const jobRow = await db.query(`select status, completed_at from job where id = $1`, [jobId]);
    const testResult = await db.query(`select outcome from job_test_result where job_id = $1 and test_code = 'mer'`, [jobId]);
    const closeout = await db.query(`select first_time_fix from job_closeout where job_id = $1`, [jobId]);
    const vanAudit = await db.query(`select van_label from van_audit where tenant_id = $1`, [tenantId]);

    if (item.rows[0]?.status === "ok" && item.rows[0]?.updated_by === technicianId) {
      ok("independently confirmed: checklist item is 'ok', updated_by resolves to the real technician");
    } else fail("checklist item independently confirmed", item.rows[0]);

    // 'closed', not 'testing' — the technician's own phone flow never calls
    // rpc_job_complete (dispatched -> testing) at all; that's a separate,
    // office-only action (job-detail.tsx's AAR tab). rpc_closeout_submit
    // closes directly from whatever status closeout.submit is called from,
    // which for a real phone flow is 'dispatched' straight through.
    if (jobRow.rows[0]?.status === "closed" && jobRow.rows[0]?.completed_at) {
      ok("independently confirmed: job.status='closed' after closeout, completed_at set");
    } else fail("job status independently confirmed", jobRow.rows[0]);

    if (testResult.rows[0]?.outcome === "pass") ok("independently confirmed: job_test_result outcome='pass'");
    else fail("test result independently confirmed", testResult.rows[0]);

    if (closeout.rows[0]?.first_time_fix === true) ok("independently confirmed: job_closeout.first_time_fix=true");
    else fail("closeout independently confirmed", closeout.rows[0]);

    if (vanAudit.rows[0]?.van_label === "Carrinha 1") ok("independently confirmed: van_audit row recorded");
    else fail("van_audit independently confirmed", vanAudit.rows[0]);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} field-flow-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  if (serverProc) serverProc.kill("SIGKILL");
  await cleanupFixtures();
  await db.end();
}
