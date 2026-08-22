// Phase 2 exit-criterion proof (05-phase2-job-loop.md §10):
//
//   "a technician completes readiness → execution → close-out on the phone
//   UI, offline, zero typed text ... proven the same way Phase 1 was, over
//   real HTTP, not asserted."
//
// Same shape as apps/api/test/phase1-proof.mjs, extended, not replaced: a
// real child-process server, a cookie-jar Session per "device", and a
// SIGKILL-mid-sync restart to prove the offline-sync infra generalizes
// beyond the one trivial mutation Phase 1 proved it against.
//
// Usage: npm run proof:phase2   (from apps/api, or via the root
// proof:phase2 script)

import { spawn } from "node:child_process";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { resetFastifySchema, openDirectConnection } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
// Own runtime dir, own port — distinct from phase1-proof.mjs's
// fieldready-proof/3911 so the two proofs can run independently (or back
// to back) without fighting over the same TCP port or (real-Postgres swap,
// apps/api/src/db.ts) the same Postgres schema.
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-proof-phase2");
const FIXTURES_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_phase2";
const PORT = 3912;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "phase2-proof-fixed-secret"; // fixed across restart so a live cookie stays valid

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// for the same "zero build step" reason phase1-proof.mjs's own comment
// gives (plain Node, no tsx, runnable standalone). Phase 2 has no fixtures
// file of its own: db.ts applies schema + seed.sql + Phase 1 fixtures on
// every fresh boot regardless of which proof is driving it, and tenant A's
// seeded compliance_profile is 'ited_ready' — exactly what's needed to
// exercise the test-protocol snapshot and the ited_classification dispatch
// condition below.
const CREDS = {
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
};

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail}`); }
function note(label) { console.log(`  NOTE ${label}`); }

// ---- tiny cookie-jar HTTP client, one per "device" ------------------------

class Session {
  cookie = null;

  async _consume(res) {
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length > 0) this.cookie = setCookie[0].split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    return { status: res.status, json };
  }

  async req(method, p, body) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this._consume(res);
  }

  get(p) { return this.req("GET", p); }
  post(p, body) { return this.req("POST", p, body ?? {}); }
  patch(p, body) { return this.req("PATCH", p, body ?? {}); }

  // Multipart upload (05-phase2-job-loop.md §7: "binary bytes travel as a
  // separate part, never through the JSON sync envelope"). No
  // content-type header set here on purpose — fetch's FormData sets its own
  // multipart boundary, which a hardcoded "application/json" would break.
  async postForm(p, formData) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + p, { method: "POST", headers, body: formData });
    return this._consume(res);
  }
}

// ---- server process lifecycle ---------------------------------------------

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
          FIELDREADY_RUNTIME_DIR: RUNTIME_DIR,
          FASTIFY_DB_SCHEMA,
          LOG: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let settled = false;
    const onData = (d) => {
      const s = d.toString();
      if (!settled && s.includes("listening on")) { settled = true; resolve(proc); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    proc.on("exit", (code) => {
      if (!settled) reject(new Error(`server exited early with code ${code}`));
    });
    setTimeout(() => { if (!settled) reject(new Error("server did not report ready in time")); }, 15000);
  });
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(BASE + "/health");
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("health check never went green");
}

function killServerHard() {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.killed) return resolve();
    serverProc.once("exit", () => resolve());
    serverProc.kill("SIGKILL"); // not SIGTERM — this is meant to be ungraceful
  });
}

// ---- domain helpers ---------------------------------------------------

// Ported verbatim from apps/api/src/domain/job-creation.ts's own slugify —
// duplicated here for the same zero-build-step reason CREDS above is, so
// this script can predict the `readiness_<slug>` / `execution_<slug>` /
// `test_protocol_<slug>` template codes job-creation.ts will look up.
function slugify(input) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const JOB_TYPE = "TDT - instalacao nova"; // matches the prototype's fixture naming, per task instructions
const SLUG = slugify(JOB_TYPE);

// F13's real, verified Tabela 6.12 limits (seed.sql, system template
// coax_smatv_tt_tabela_6_12) — job-creation.ts now resolves the
// test_protocol snapshot by `network_type` (inferred from job_type's
// keywords: "TDT" -> SMATV), not by a `test_protocol_<job_type_slug>` code,
// so this job's test_protocol_snapshot resolves straight to seed.sql's real
// system-layer, already-verified template — no tenant-owned copy needed to
// make it reachable. Kept here only as the expected-value fixture the
// assertions below check the resolved snapshot against, so a regression in
// the resolution logic (or a seed.sql edit) would be caught by an assertion
// failure rather than silently passing on a script-local substitute.
const TABELA_6_12_TESTS = [
  { id: "nivel_sinal_hertziana", label: "Nível de sinal — TDT hertziana (64QAM, Zona A)", unit: "dBµV", dir: "range", min: 45, max: 74, recommended: 55, limit_ref: "Tabela 6.12" },
  { id: "mer_hertziana", label: "MER — TDT hertziana (64QAM, Zona A)", unit: "dB", dir: "min", min: 19.5, recommended: 26, limit_ref: "Tabela 6.12" },
  { id: "nivel_sinal_satelite", label: "Nível de sinal — TDT satélite (8PSK, Zona B)", unit: "dBµV", dir: "range", min: 47, max: 77, recommended: 55, limit_ref: "Tabela 6.12" },
  { id: "mer_satelite", label: "MER — TDT satélite (8PSK, Zona B)", unit: "dB", dir: "min", min: 14, recommended: 17, limit_ref: "Tabela 6.12" },
];

// 1x1 transparent PNG — a tiny, real, decodable image, not just arbitrary
// bytes, for the multipart photo upload (§10 step 5's "a photo").
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Creates a template of `kind`, publishes one version with `body`, and
// activates it. For test_protocol kind, `activatePayload` must carry
// {verified_by, verified_source} — the activation gate this whole schema
// exists to protect (CLAUDE.md); for every other kind, activation takes no
// body. Mirrors templates.ts's own two-step draft→activate flow, same as
// phase1-proof.mjs already does for its proof_test_protocol template.
async function createAndActivateTemplate(session, { kind, code, title, body, activatePayload }) {
  const createTpl = await session.post("/templates", { kind, code, title });
  if (createTpl.status !== 201) {
    throw new Error(`template creation failed for ${code}: ${createTpl.status} ${JSON.stringify(createTpl.json)}`);
  }
  const templateId = createTpl.json.id;

  const version = await session.post(`/templates/${templateId}/versions`, { body });
  if (version.status !== 201) {
    throw new Error(`version creation failed for ${code}: ${version.status} ${JSON.stringify(version.json)}`);
  }

  const activate = await session.post(
    `/templates/${templateId}/versions/${version.json.version}/activate`,
    activatePayload ?? {}
  );
  if (activate.status !== 200) {
    throw new Error(`activation failed for ${code}: ${activate.status} ${JSON.stringify(activate.json)}`);
  }
  return templateId;
}

// ---- run ---------------------------------------------------------------

async function main() {
  console.log(`Clean slate: removing ${RUNTIME_DIR}`);
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);

  console.log("Starting API (first boot — applies schema/seed/Phase 1 fixtures)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  if (!existsSync(FIXTURES_PATH)) {
    fail("fixtures file present", `expected at ${FIXTURES_PATH}`);
    return finish();
  }
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
  ok("fixtures loaded");

  const officeA = new Session();
  const loginA = await officeA.post("/auth/office/login", {
    email: CREDS.officeAEmail, password: CREDS.officeAPassword,
  });
  if (loginA.status === 200) ok("auth: office A login succeeds");
  else { fail("auth: office A login succeeds", `status ${loginA.status}`); return finish(); }

  const pair = await officeA.post("/auth/technician/pair", {
    inviteToken: fixtures.officeAId, deviceLabel: "Phase 2 proof phone", pin: "4321",
  });
  if (pair.status !== 201 || !pair.json?.device_id) {
    fail("auth: technician device pairing succeeds", `status ${pair.status} ${JSON.stringify(pair.json)}`);
    return finish();
  }
  ok("auth: technician device pairing succeeds");

  const technician = new Session();
  const techLogin = await technician.post("/auth/technician/login", {
    deviceId: pair.json.device_id, pin: "4321",
  });
  if (techLogin.status === 200) ok("auth: technician PIN login succeeds");
  else { fail("auth: technician PIN login succeeds", `status ${techLogin.status}`); return finish(); }

  // ---- 1. Client -> Quote -> BOM -> templates -> accept -> create-job ----

  const client = await officeA.post("/clients", { name: "F. Marques — Phase 2 proof" });
  if (client.status === 201) ok("clients: create client");
  else { fail("clients: create client", `status ${client.status}`); return finish(); }
  const clientId = client.json.id;

  const quote = await officeA.post("/quotes", {
    client_id: clientId, job_type: JOB_TYPE, quoted_hours: 4, quoted_materials: 180.5,
  });
  if (quote.status === 201) ok("quotes: create quote");
  else { fail("quotes: create quote", `status ${quote.status}`); return finish(); }
  const quoteId = quote.json.id;

  const lines = await officeA.patch(`/quotes/${quoteId}/lines`, {
    lines: [{ description: "Amplificador de mastro (linha da proposta)", qty: 1, unit_price: 45.9 }],
  });
  if (lines.status === 200 && lines.json.lines?.length === 1) ok("quotes: BOM line added");
  else { fail("quotes: BOM line added", `status ${lines.status} ${JSON.stringify(lines.json)}`); return finish(); }

  // No pre-existing checklist/execution template matches this job_type's
  // slug in seed data, so job-creation.ts's system-template fallback would
  // otherwise resolve to null/empty for both — create tenant-owned
  // templates first so create-job's snapshot-resolution logic
  // (05-phase2-job-loop.md §4) has a real, non-trivial checklist/execution
  // to resolve. test_protocol is deliberately NOT set up this way below:
  // job-creation.ts resolves it by `network_type` (inferred from job_type's
  // keywords), not by a job-type-slug code, so this job's job_type ("TDT -
  // instalacao nova" -> infers SMATV) resolves straight through to
  // seed.sql's real, already-verified system-layer coax_smatv_tt_tabela_6_12
  // template with no tenant-owned copy needed — see the assertion after
  // create-job below, which checks the resolved snapshot against the real
  // seeded numbers.
  await createAndActivateTemplate(officeA, {
    kind: "checklist",
    code: `readiness_${SLUG}`,
    title: "Readiness — TDT instalação nova (Phase 2 proof)",
    body: {
      items: [
        { cat: "material", label: "Cabo coaxial RG6 (rolo)", qty: 1, scope: "job", mandatory: true },
        { cat: "equipment", label: "Amplificador de mastro", qty: 1, scope: "job", mandatory: true },
        { cat: "equipment", label: "Kit de ferramentas do técnico verificado", qty: 1, scope: "van", mandatory: true },
        { cat: "doc", label: "Termo de responsabilidade assinado", qty: 1, scope: "office", mandatory: true },
      ],
    },
  });
  ok("templates: checklist template created and activated");

  await createAndActivateTemplate(officeA, {
    kind: "execution_steps",
    code: `execution_${SLUG}`,
    title: "Execução — TDT instalação nova (Phase 2 proof)",
    body: {
      steps: [
        { order: 0, label: "Montagem do suporte e fixação" },
        { order: 1, label: "Passagem de cablagem" },
        { order: 2, label: "Teste final e verificação de sinal" },
      ],
    },
  });
  ok("templates: execution_steps template created and activated");

  const accept = await officeA.post(`/quotes/${quoteId}/accept`);
  if (accept.status === 200 && accept.json.status === "accepted") ok("quotes: accept");
  else { fail("quotes: accept", `status ${accept.status} ${JSON.stringify(accept.json)}`); return finish(); }

  const createJob = await officeA.post(`/quotes/${quoteId}/create-job`);
  if (createJob.status !== 201) {
    fail("quotes: create-job", `status ${createJob.status} ${JSON.stringify(createJob.json)}`);
    return finish();
  }
  ok("quotes: create-job succeeds");
  const jobId = createJob.json.id;

  // 4 template items (2 job + 1 van + 1 office) + 1 merged, uncovered quote
  // line (no item_id -> always merges, per job-creation.ts §4 step 4) = 5
  // total, 3 job-scope.
  const scopeCounts = createJob.json.checklist?.by_scope ?? {};
  const scopeKeysOk = Object.keys(scopeCounts).every((k) => ["job", "van", "office"].includes(k));
  const countsOk =
    createJob.json.checklist?.total >= 1 &&
    scopeKeysOk &&
    scopeCounts.job === 3 && scopeCounts.van === 1 && scopeCounts.office === 1 &&
    createJob.json.checklist?.merged_from_quote === 1;
  if (countsOk) ok("create-job: checklist counts match resolved template + merged quote line (job=3, van=1, office=1)");
  else fail("create-job: checklist counts sane", JSON.stringify(createJob.json.checklist));

  if (createJob.json.has_execution_snapshot && createJob.json.has_test_protocol_snapshot) {
    ok("create-job: execution_snapshot and test_protocol_snapshot both resolved (ited_ready tenant, SMATV protocol)");
  } else {
    fail("create-job: execution/test_protocol snapshots resolved", JSON.stringify(createJob.json));
  }

  // Review finding (medium, job-creation.ts:129, now fixed): confirm
  // test_protocol_snapshot resolved to seed.sql's real, verified
  // system-layer coax_smatv_tt_tabela_6_12 template (network_type
  // resolution, §7's rationale for building F13/F14 capture in Phase 2 —
  // "already seeded, verified, and activatable" — actually reachable from a
  // real job, not just from a script-local tenant-owned workaround).
  const jobAfterCreate = await officeA.get(`/jobs/${jobId}`);
  const resolvedProtocol = jobAfterCreate.json?.test_protocol_snapshot;
  const resolvedNivelHertziana = resolvedProtocol?.tests?.find((t) => t.id === "nivel_sinal_hertziana");
  const matchesSeededTabela612 =
    resolvedProtocol?.network_type === "SMATV" &&
    Array.isArray(resolvedProtocol?.tests) &&
    resolvedProtocol.tests.length === TABELA_6_12_TESTS.length &&
    resolvedNivelHertziana?.min === 45 &&
    resolvedNivelHertziana?.max === 74 &&
    resolvedNivelHertziana?.limit_ref === "Tabela 6.12";
  if (matchesSeededTabela612) {
    ok("create-job: test_protocol_snapshot resolved from the real seed.sql system template (network_type match, not job-type-slug code)");
  } else {
    fail("create-job: test_protocol_snapshot matches seed.sql's Tabela 6.12 system template", JSON.stringify(resolvedProtocol));
  }

  const readinessAfterCreate = await officeA.get(`/jobs/${jobId}/readiness`);
  const itemsAfterCreate = readinessAfterCreate.json?.items ?? [];
  const onlyValidScopes = itemsAfterCreate.every((i) => ["job", "van", "office"].includes(i.scope));
  if (itemsAfterCreate.length >= 1 && onlyValidScopes) {
    ok("readiness: item scopes are only job/van/office, at least one item");
  } else {
    fail("readiness: item scopes sane", JSON.stringify(itemsAfterCreate.map((i) => i.scope)));
  }

  // ---- 2. Dispatch before readiness is met -> 409 ------------------------

  const earlyDispatch = await officeA.post(`/jobs/${jobId}/dispatch`);
  const earlyBlocking = earlyDispatch.json?.blocking ?? [];
  const hasChecklistBlock = earlyBlocking.some((b) => b.kind === "checklist_item");
  const hasVanBlock = earlyBlocking.some((b) => b.kind === "van_audit_stale");
  if (earlyDispatch.status === 409 && earlyDispatch.json?.error === "not_ready" && hasChecklistBlock) {
    ok("dispatch: blocked with 409 not_ready before readiness is met (checklist_item present)");
  } else {
    fail("dispatch: blocked before readiness met", `status ${earlyDispatch.status} ${JSON.stringify(earlyDispatch.json)}`);
  }
  if (hasVanBlock) ok("dispatch: blocking also includes a van_audit_stale entry (no van_audit exists yet)");
  else note("dispatch: no van_audit_stale entry in blocking (unexpected, but not asserted as fatal)");

  // ---- 3. Satisfy the gate: checklist, van audit, ited review -----------

  const mandatoryJobItems = itemsAfterCreate.filter((i) => i.scope === "job" && i.mandatory && i.status !== "ok");
  for (const item of mandatoryJobItems) {
    const mutation = {
      client_mutation_id: crypto.randomUUID(),
      type: "checklist_item.update",
      job_id: jobId,
      payload: { item_id: item.id, status: "ok" },
      occurred_at: new Date().toISOString(),
    };
    const res = await technician.post("/sync/mutations", { mutations: [mutation] });
    if (res.json?.results?.[0]?.status !== "applied") {
      fail("sync: checklist_item.update applies", JSON.stringify(res.json));
    }
  }
  const readinessAfterChecklist = await officeA.get(`/jobs/${jobId}/readiness`);
  const stillMissing = (readinessAfterChecklist.json?.items ?? []).filter(
    (i) => i.scope === "job" && i.mandatory && i.status !== "ok"
  );
  if (stillMissing.length === 0) ok(`sync: all ${mandatoryJobItems.length} mandatory job-scope checklist items marked ok`);
  else fail("sync: all mandatory job-scope checklist items marked ok", JSON.stringify(stillMissing));

  const vanAudit = await technician.post("/van-audits", { van_label: "VAN-01", issues: [] });
  if (vanAudit.status === 201 && vanAudit.json?.next_due_at) ok("van-audits: fresh audit recorded");
  else fail("van-audits: fresh audit recorded", `status ${vanAudit.status} ${JSON.stringify(vanAudit.json)}`);

  // v_job_readiness (§7 below) counts mandatory job_checklist_item rows
  // across ALL scopes, not just scope='job' — the dispatch gate itself only
  // cares about scope='job' status and the separate van_audit table (§6a),
  // it never flips the van/office-scope checklist ROWS to 'ok' as a side
  // effect. Mark those via the office-side direct PATCH route (§5 — not
  // exercised anywhere else in this script) so the closed job reaches
  // genuine 100% readiness for the dashboard check, rather than leaving
  // van/office rows stuck at 'missing' despite the underlying van audit and
  // office paperwork both being real and current.
  const nonJobItems = itemsAfterCreate.filter((i) => i.scope !== "job");
  for (const item of nonJobItems) {
    const patched = await officeA.patch(`/jobs/${jobId}/checklist/${item.id}`, { status: "ok" });
    if (patched.status !== 200 || patched.json?.status !== "ok") {
      fail("checklist: office direct PATCH marks van/office item ok", JSON.stringify(patched.json));
    }
  }
  ok(`checklist: office direct PATCH marks ${nonJobItems.length} van/office-scope item(s) ok`);

  // Equipment calibration (condition c) — a real, non-vacuous test. A prior
  // pass left this "vacuously satisfied" (no equipment/calibration setup at
  // all), which never actually exercised dispatch-gate.ts's calibration
  // comparison — and that comparison turned out to have a real bug (found
  // while porting this logic to Supabase's rpc_dispatch_json, a pure-SQL
  // date comparison there with no JS coercion pitfall to hit): PGlite (like
  // most Postgres drivers) returns `date` columns as JS Date objects, not
  // plain strings, and comparing a Date object to a string via `<` coerces
  // the Date through toString() (a locale string), not toISOString() — so
  // the old lexicographic comparison never actually detected an expired
  // instrument, for any date. Fixed in dispatch-gate.ts (toIsoDate()); this
  // is the check that would have caught it, added now instead of only
  // noting the gap.
  //
  // test_protocol_snapshot has no HTTP write path (architecture §5:
  // "resolved once, never re-read/rewritten") — injecting an instrument_id
  // into one already-frozen test entry needs the same direct-DB-access
  // pattern this file's own SIGKILL tests already use elsewhere, not a new
  // one invented for this. Equipment creation and calibration DO have real
  // routes (POST /equipment, POST /equipment/:id/calibration), so only the
  // snapshot injection needs direct DB access.

  const equipmentCreate = await officeA.post("/equipment", { kind: "Medidor de campo DVB-T2", supports_export: false });
  const equipmentId = equipmentCreate.json?.id;
  if (equipmentCreate.status === 201 && equipmentId) ok("equipment: created via POST /equipment");
  else fail("equipment: created via POST /equipment", `status ${equipmentCreate.status} ${JSON.stringify(equipmentCreate.json)}`);

  const expiredCalibration = await officeA.post(`/equipment/${equipmentId}/calibration`, {
    cert_file: "cert-expired.pdf", issued_on: "2019-01-01", expires_on: "2020-01-01",
  });
  if (expiredCalibration.status === 200 && expiredCalibration.json?.calibration_expires_on) {
    ok("equipment: calibration recorded via POST /equipment/:id/calibration (already expired: 2020-01-01)");
  } else {
    fail("equipment: calibration recorded (expired)", `status ${expiredCalibration.status} ${JSON.stringify(expiredCalibration.json)}`);
  }

  await killServerHard();
  ok("server killed (SIGKILL) before direct DB access — never two things touching the same schema at once");
  {
    const directDb = await openDirectConnection(FASTIFY_DB_SCHEMA);
    const jobRow = await directDb.query(`select test_protocol_snapshot from job where id = $1;`, [jobId]);
    const snapshot = jobRow.rows[0].test_protocol_snapshot;
    snapshot.tests[0].instrument_id = equipmentId;
    await directDb.query(`update job set test_protocol_snapshot = $1 where id = $2;`, [JSON.stringify(snapshot), jobId]);
    await directDb.end();
  }
  ok("direct-db: instrument_id injected into the job's frozen test_protocol_snapshot (no HTTP route exists for this, by design)");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server restarted and reconnected to the same Postgres schema");

  const blockedByCalibration = await officeA.post(`/jobs/${jobId}/dispatch`);
  const calibrationBlocking = (blockedByCalibration.json?.blocking ?? []).find(
    (b) => b.kind === "calibration_expired" && b.equipment_id === equipmentId
  );
  if (blockedByCalibration.status === 409 && calibrationBlocking) {
    ok(`dispatch: blocked with calibration_expired for the real expired instrument (expired_on=${calibrationBlocking.expired_on})`);
  } else {
    fail("dispatch: blocked by expired calibration", `status ${blockedByCalibration.status} ${JSON.stringify(blockedByCalibration.json)}`);
  }

  const renewedCalibration = await officeA.post(`/equipment/${equipmentId}/calibration`, {
    cert_file: "cert-valid.pdf", issued_on: "2026-01-01", expires_on: "2099-01-01",
  });
  if (renewedCalibration.status === 200) ok("equipment: calibration renewed to a future date (2099-01-01)");
  else fail("equipment: calibration renewed", `status ${renewedCalibration.status}`);

  // Condition (d): tenant is 'ited_ready' (non-basic), so ited_classification
  // must have been explicitly reviewed by a human (ited_classification_by
  // IS NOT NULL) before dispatch — CLAUDE.md/PRD §7, the technician never
  // classifies anything, so this PATCH runs as officeA, not the technician.
  const classify = await officeA.patch(`/jobs/${jobId}`, { ited_classification: "existing_alteration" });
  if (classify.status === 200 && classify.json?.ited_classification_by) {
    ok("jobs: office reviews ited_classification (stamps ited_classification_by)");
  } else {
    fail("jobs: office reviews ited_classification", `status ${classify.status} ${JSON.stringify(classify.json)}`);
  }

  // ---- Dispatch retry -> 200 with all three snapshots --------------------

  const dispatch = await officeA.post(`/jobs/${jobId}/dispatch`);
  const snapshotsPresent =
    dispatch.json?.readiness_snapshot != null &&
    dispatch.json?.execution_snapshot != null &&
    dispatch.json?.test_protocol_snapshot != null;
  if (dispatch.status === 200 && snapshotsPresent) {
    ok("dispatch: succeeds once readiness/van/classification are satisfied, snapshots present");
  } else {
    fail("dispatch: succeeds after gate satisfied", `status ${dispatch.status} ${JSON.stringify(dispatch.json)}`);
    return finish();
  }

  // Review finding (medium, jobs.ts:198, now fixed): a job that's already
  // past 'ready_check' must not be re-dispatchable even if its stale
  // checklist/van-audit/classification data still happens to satisfy the
  // gate — this job's gate conditions are all still (vacuously) true right
  // now, so this is a real test of the status precondition, not of the gate
  // itself re-failing.
  const redispatch = await officeA.post(`/jobs/${jobId}/dispatch`);
  if (redispatch.status === 409 && redispatch.json?.error === "wrong_status") {
    ok("dispatch: re-dispatching an already-dispatched job is rejected (409 wrong_status), not silently reverted");
  } else {
    fail("dispatch: re-dispatch rejected by status precondition", `status ${redispatch.status} ${JSON.stringify(redispatch.json)}`);
  }

  // ---- 4. Execution, photo, test results ---------------------------------

  const stepComplete = await technician.post(`/jobs/${jobId}/execution-steps/0/complete`);
  if (stepComplete.status === 200 && stepComplete.json?.step_order === 0) {
    ok("execution-steps: step 0 completed via direct HTTP route");
  } else {
    fail("execution-steps: step 0 completed", `status ${stepComplete.status} ${JSON.stringify(stepComplete.json)}`);
  }

  const pngBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
  const form = new FormData();
  form.append("phase", "during");
  form.append("file", new Blob([pngBuffer], { type: "image/png" }), "proof.png");
  const photo = await technician.postForm(`/jobs/${jobId}/photos`, form);
  if (photo.status === 200 && photo.json?.phase === "during") ok("photos: multipart upload succeeds");
  else fail("photos: multipart upload succeeds", `status ${photo.status} ${JSON.stringify(photo.json)}`);

  // Three outlets' worth of F13 (Tabela 6.12) readings, reusing the same
  // real, verified limits seed.sql carries — two via the sync mutation path
  // (the phone's real path), one via the direct HTTP route so we can read
  // back the server-computed `outcome` in the same response.
  const testLocations = ["Sala", "Quarto 1"];
  for (const location of testLocations) {
    const mutation = {
      client_mutation_id: crypto.randomUUID(),
      type: "test_result.record",
      job_id: jobId,
      payload: {
        network_type: "SMATV",
        location_label: location,
        test_code: "nivel_sinal_hertziana",
        measured_value: "55",
        unit: "dBµV",
        capture_source: "manual",
      },
      occurred_at: new Date().toISOString(),
    };
    const res = await technician.post("/sync/mutations", { mutations: [mutation] });
    if (res.json?.results?.[0]?.status !== "applied") {
      fail(`sync: test_result.record applies (${location})`, JSON.stringify(res.json));
    }
  }
  ok("sync: test_result.record applies for 2 outlets via sync mutations");

  const directTestResult = await technician.post(`/jobs/${jobId}/test-results`, {
    network_type: "SMATV",
    location_label: "Quarto 2",
    test_code: "nivel_sinal_hertziana",
    measured_value: "55",
    unit: "dBµV",
    capture_source: "manual",
  });
  if (directTestResult.status === 200 && directTestResult.json?.outcome === "pass") {
    ok("test-results: direct HTTP route computes outcome='pass' against the frozen Tabela 6.12 snapshot");
  } else {
    fail("test-results: direct route outcome", `status ${directTestResult.status} ${JSON.stringify(directTestResult.json)}`);
  }

  // ---- 5/6. Complete + close-out ------------------------------------------

  const complete = await technician.post(`/jobs/${jobId}/complete`);
  if (complete.status === 200 && complete.json?.status === "testing" && complete.json?.completed_at) {
    ok("jobs: complete stamps completed_at, moves to 'testing'");
  } else {
    fail("jobs: complete", `status ${complete.status} ${JSON.stringify(complete.json)}`);
  }

  const closeoutMutation = {
    client_mutation_id: crypto.randomUUID(),
    type: "closeout.submit",
    job_id: jobId,
    payload: {
      first_time_fix: true,
      technician_note_transcript: "Instalação concluída, sinal e MER dentro dos limites da Tabela 6.12.",
    },
    occurred_at: new Date().toISOString(),
  };
  const closeoutRes = await technician.post("/sync/mutations", { mutations: [closeoutMutation] });
  if (closeoutRes.json?.results?.[0]?.status === "applied") {
    ok("sync: closeout.submit applies (first_time_fix: true)");
  } else {
    fail("sync: closeout.submit applies", JSON.stringify(closeoutRes.json));
  }

  const reworkAttempt = await technician.patch(`/jobs/${jobId}/closeout/rework-cause`, {
    rework_cause: "should be rejected",
  });
  if (reworkAttempt.status === 403) ok("closeout: technician cannot set rework_cause (office-only)");
  else fail("closeout: technician cannot set rework_cause", `status ${reworkAttempt.status}`);

  // ---- 7. Dashboard-relevant check ----------------------------------------
  //
  // v_job_readiness IS reachable, via GET /jobs/:id/readiness (05-phase2-
  // job-loop.md §5) — confirm it reflects the real job just closed, not
  // seeded data (PRD §8). v_first_time_fix_rate has no route exposing it
  // anywhere in this phase's route surface (grepped across apps/api/src/
  // routes/) — per this task's own fallback instruction, that one
  // assertion is skipped rather than inventing a route that doesn't exist;
  // noted here and in the final summary, not silently dropped.
  const finalReadiness = await officeA.get(`/jobs/${jobId}/readiness`);
  const summary = finalReadiness.json ?? {};
  if (summary.mandatory_total >= 1 && summary.mandatory_ok === summary.mandatory_total) {
    ok(`dashboard: v_job_readiness (via GET /jobs/:id/readiness) shows ${summary.mandatory_ok}/${summary.mandatory_total} mandatory items ok for the real, just-closed job`);
  } else {
    fail("dashboard: v_job_readiness reflects closed job", JSON.stringify(summary));
  }
  note("dashboard: v_first_time_fix_rate has no reachable route in this phase — skipped per task instructions, not invented.");

  // ---- 8. SIGKILL-mid-sync, on execution_step.complete --------------------
  //
  // Same scenario phase1-proof.mjs proves on checklist_item.update, here on
  // a real job-domain mutation type to confirm the sync infra generalizes.
  // Note: unlike checklist_item.update, job_execution_step_completion has
  // no GET route anywhere in this phase's surface (no dashboard/list route
  // reads it either) — "no double-effect" is therefore evidenced the same
  // way the `already_applied` branch itself guarantees it structurally
  // (apps/api/src/routes/sync.ts: the lookup-by-client_mutation_id branch
  // returns early and never calls applyMutation a second time), rather than
  // by an independent read-back assertion phase1's checklist item happened
  // to allow. Flagged here and in the final summary rather than inventing a
  // new route to read job_execution_step_completion.

  const stepMutationId1 = crypto.randomUUID();
  const stepBatch1 = {
    mutations: [{
      client_mutation_id: stepMutationId1,
      type: "execution_step.complete",
      job_id: jobId,
      payload: { step: 1 },
      occurred_at: new Date().toISOString(),
    }],
  };
  const stepSync1 = await technician.post("/sync/mutations", stepBatch1);
  if (stepSync1.json?.results?.[0]?.status === "applied") {
    ok("sync: execution_step.complete (step 1) applies");
  } else {
    fail("sync: execution_step.complete (step 1) applies", JSON.stringify(stepSync1.json));
  }

  console.log("  ...  killing the server (SIGKILL) to simulate a crash mid-sync");
  await killServerHard();
  ok("server process killed");

  console.log("  ...  restarting against the same on-disk data");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server restarted and reconnected to the same Postgres schema");

  // Same technician cookie, minted before the kill — proves a device mid-
  // sync when the app died doesn't need to re-authenticate to finish the
  // retry (same as phase1-proof.mjs's own scenario).
  const stepReplay1 = await technician.post("/sync/mutations", stepBatch1);
  if (stepReplay1.json?.results?.[0]?.status === "already_applied") {
    ok("sync: replaying the identical execution_step.complete batch after restart returns already_applied (idempotent)");
  } else {
    fail("sync: idempotent replay of execution_step.complete after restart", JSON.stringify(stepReplay1.json));
  }

  const stepMutationId2 = crypto.randomUUID();
  const stepSync2 = await technician.post("/sync/mutations", {
    mutations: [{
      client_mutation_id: stepMutationId2,
      type: "execution_step.complete",
      job_id: jobId,
      payload: { step: 2 },
      occurred_at: new Date().toISOString(),
    }],
  });
  if (stepSync2.json?.results?.[0]?.status === "applied") {
    ok("sync: a genuinely new execution_step.complete mutation after restart still applies (server fully functional)");
  } else {
    fail("sync: new mutation after restart applies", JSON.stringify(stepSync2.json));
  }

  await finish();
}

async function finish() {
  await killServerHard();
  console.log("\n" + (failures === 0
    ? "All Phase 2 exit-criterion checks passed."
    : `${failures} check(s) failed — see FAIL lines above.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Proof script crashed:", err);
  await killServerHard();
  process.exit(1);
});
