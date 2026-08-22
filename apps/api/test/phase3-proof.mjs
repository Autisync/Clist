// Phase 3 exit-criterion proof (06-phase3-compliance.md §8):
//
//   "a real ited_full job produces a reconciled REF+termo pair with correct
//   deadline dates against a real PT working-day calendar, over HTTP, plus
//   F11/F12 seeded and verified the same way F13/F14 already are."
//
// Same shape as apps/api/test/phase2-proof.mjs, extended, not replaced: a
// real child-process server, a cookie-jar Session per "device", real HTTP
// only. Own RUNTIME_DIR and own fixed port (3914) so this proof can run
// independently of, or back to back with, phase1/phase2's.
//
// Usage: npm run proof:phase3   (from apps/api, or via the root
// proof:phase3 script)

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import Holidays from "date-holidays";
import { resetFastifySchema } from "./db-reset.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-proof-phase3");
const FIXTURES_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");
// Real-Postgres swap: db.ts now persists into a real Postgres schema, not
// an on-disk PGlite directory — this proof's own dedicated schema.
const FASTIFY_DB_SCHEMA = "fastify_api_proof_phase3";
const PORT = 3914;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "phase3-proof-fixed-secret"; // fixed across restart so a live cookie stays valid, same reason phase2-proof.mjs's own comment gives (not exercised here, kept for parity)

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// for the same "zero build step" reason phase1/phase2-proof.mjs's own
// comments give (plain Node, no tsx, runnable standalone). Tenant A is
// seeded 'ited_ready' (non-basic — exactly what §7's REF/termo/deadline
// routes require); tenant B has no compliance_profile in its insert, so it
// takes the schema default 'basic' — exactly what step 8's 403 checks need.
// Confirmed against apps/api/src/fixtures.ts directly, not assumed.
const CREDS = {
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
  officeBEmail: "owner@concorrente.pt",
  officeBPassword: "proof-pass-456",
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
    serverProc.kill("SIGKILL");
  });
}

// ---- domain helpers ---------------------------------------------------

// Ported verbatim from apps/api/src/domain/job-creation.ts's own slugify —
// duplicated here for the same zero-build-step reason phase2-proof.mjs's
// CREDS/slugify already are.
function slugify(input) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// A job_type wording that job-creation.ts's (now generalized,
// 06-phase3-compliance.md §2a) inferNetworkTypeFromJobType infers to "PC",
// not "SMATV"/"FO" which Phase 2 already exercises — "estruturada" (cablagem
// estruturada / structured copper cabling) is one of PC's dedicated
// keywords and shares no token with the FO/CC/SMATV keyword lists, so this
// resolves unambiguously.
const JOB_TYPE = "Cablagem estruturada - instalação nova";
const SLUG = slugify(JOB_TYPE);

// F11's real, verified Tabela 6.1/6.1.1 protocol (seed.sql, system template
// pares_cobre_tabela_6_1) — kept here only as the expected-value fixture the
// assertions below check the resolved snapshot against, same spirit as
// phase2-proof.mjs's own TABELA_6_12_TESTS comment: a regression in the
// resolution logic (or a seed.sql edit) is caught by an assertion failure,
// not silently passed on a script-local substitute.
const EXPECTED_F11_NETWORK_TYPE = "PC";
const EXPECTED_F11_TEST_CODE = "return_loss";
const EXPECTED_F11_LIMIT_REF = "Tabela 6.1/6.1.1";

// Creates a template of `kind`, publishes one version with `body`, and
// activates it. Ported verbatim from phase2-proof.mjs.
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

// PT working-day arithmetic, ported verbatim from packages/core/src/deadlines.ts
// (addWorkingDays) — duplicated here for the same "zero build step, run
// standalone with plain node" reason every other domain helper in this file
// is, so this script can independently compute the expected due_on and
// assert the server's real, HTTP-returned value against it, rather than
// trusting the same code path it's meant to be proving. Same algorithm:
// UTC-midnight calendar-day stepping, weekends + `type: "public"` PT
// holidays skipped, the fromDate's own day never counted.
function addWorkingDaysExpected(fromDate, days, { subdivision } = {}) {
  const hd = subdivision ? new Holidays("PT", subdivision) : new Holidays("PT");
  function isWorkingDay(date) {
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    const found = hd.isHoliday(date);
    if (found && found.some((h) => h.type === "public")) return false;
    return true;
  }
  let cursor = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
  let remaining = days;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    if (isWorkingDay(cursor)) remaining -= 1;
  }
  return cursor;
}
function isoDate(d) { return d.toISOString().slice(0, 10); }

// `date`-typed columns can come back as either a plain 'YYYY-MM-DD' string
// or a JS Date object depending on the driver/serialization path in between
// (PGlite parses them into Date objects — a real, previously-undetected bug
// in dispatch-gate.ts's calibration check turned out to hinge on exactly
// this, see that file's own comment; apps/api/src/db.ts now pins `pg`'s
// date parser back to a raw string for parity) — normalize defensively so
// this assertion doesn't care which shape actually made it through.
function normalizeDueOn(value) {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return isoDate(value);
  return String(value).slice(0, 10);
}

// A fixed reference date, not "whenever this script happens to run": 2026
// Sexta-Feira Santa (Good Friday) falls on Friday 2026-04-03 — a weekday a
// naive weekend-only calendar would happily count as a working day, but a
// real PT public-holiday calendar skips. Issuing the termo on 2026-04-01
// (Wednesday) makes the naive and holiday-aware 10-working-day answers
// disagree by exactly one day (2026-04-15 vs 2026-04-16) — confirmed via
// date-holidays's own 2026 PT output before writing this script, not
// guessed. termo_responsabilidade.issued_at is client-supplied (unlike
// job.completed_at, which is stamped server-side from `now()`), so this is
// the deadline clock this script can actually engineer the exit criterion's
// "pick a completion moment such that a naive and holiday-aware calendar
// disagree" scenario against.
const TERMO_ISSUED_AT = "2026-04-01T09:00:00Z";
const EXPECTED_REF_DUE_ON = isoDate(addWorkingDaysExpected(new Date(TERMO_ISSUED_AT), 10, {}));
const NAIVE_REF_DUE_ON_WOULD_BE = "2026-04-15"; // weekend-only skip, no holiday awareness

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
  if (loginA.status === 200) ok("auth: office A (tenant A, compliance_profile ited_ready) login succeeds");
  else { fail("auth: office A login succeeds", `status ${loginA.status}`); return finish(); }

  const officeB = new Session();
  const loginB = await officeB.post("/auth/office/login", {
    email: CREDS.officeBEmail, password: CREDS.officeBPassword,
  });
  if (loginB.status === 200) ok("auth: office B (tenant B, compliance_profile basic) login succeeds");
  else { fail("auth: office B login succeeds", `status ${loginB.status}`); return finish(); }

  const pair = await officeA.post("/auth/technician/pair", {
    inviteToken: fixtures.officeAId, deviceLabel: "Phase 3 proof phone", pin: "4321",
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

  // ==== 1. F11/F12 seeded + verified, and the activation gate hasn't =====
  // ====    regressed ======================================================

  const protocolList = await officeA.get("/templates?kind=test_protocol&layer=system");
  const templates = protocolList.json?.templates ?? [];
  const f11 = templates.find((t) => t.code === "pares_cobre_tabela_6_1");
  const f12 = templates.find((t) => t.code === "coax_cc_tabela_6_7_6_9");
  if (f11 && f12) ok("templates: F11 (pares_cobre_tabela_6_1) and F12 (coax_cc_tabela_6_7_6_9) both listed as system test_protocol templates");
  else fail("templates: F11/F12 both listed", JSON.stringify(templates.map((t) => t.code)));

  for (const [label, tpl] of [["F11", f11], ["F12", f12]]) {
    if (!tpl) continue;
    const versions = await officeA.get(`/templates/${tpl.id}/versions`);
    const active = (versions.json?.versions ?? []).find((v) => v.status === "active");
    if (active && active.verified_by) {
      ok(`templates: ${label} has an active version with verified_by set (activation gate satisfied, not bypassed)`);
    } else {
      fail(`templates: ${label} active + verified_by`, JSON.stringify(versions.json));
    }
  }

  // Re-confirm the gate itself still rejects an unverified test_protocol and
  // accepts a verified one, over HTTP — same scenario phase1-proof.mjs
  // proves, re-run here so a regression introduced anywhere in this phase's
  // changes (schema, template.ts's dir enum, templates.ts) would be caught.
  const draftProtocol = await officeA.post("/templates", {
    kind: "test_protocol", code: "proof_phase3_test_protocol", title: "Phase 3 proof — gate re-check",
  });
  const draftProtocolId = draftProtocol.json?.id;
  const draftVersion = await officeA.post(`/templates/${draftProtocolId}/versions`, {
    body: { network_type: "FO", tests: [{ id: "t", label: "Test", unit: "dB", dir: "max", max: 1.8, limit_ref: "Proof" }] },
  });
  const unverifiedActivate = await officeA.post(
    `/templates/${draftProtocolId}/versions/${draftVersion.json.version}/activate`, {}
  );
  if (unverifiedActivate.status === 422 && unverifiedActivate.json?.error === "unverified_test_protocol") {
    ok("gate: activating an unverified test_protocol is still rejected with 422 (no regression this phase)");
  } else {
    fail("gate: unverified activation still rejected", `status ${unverifiedActivate.status} ${JSON.stringify(unverifiedActivate.json)}`);
  }
  const verifiedActivate = await officeA.post(
    `/templates/${draftProtocolId}/versions/${draftVersion.json.version}/activate`,
    { verified_by: fixtures.officeAId, verified_source: "Phase 3 proof citation" }
  );
  if (verifiedActivate.status === 200) ok("gate: a verified test_protocol still activates cleanly (no regression this phase)");
  else fail("gate: verified activation still succeeds", `status ${verifiedActivate.status} ${JSON.stringify(verifiedActivate.json)}`);

  // ==== 2/3. Walk a job through Phase 2's full loop, network_type PC =====

  const client = await officeA.post("/clients", { name: "Escritório Central — Phase 3 proof", address: "Rua das Flores 12, Lisboa" });
  if (client.status === 201) ok("clients: create client");
  else { fail("clients: create client", `status ${client.status}`); return finish(); }
  const clientId = client.json.id;

  const quote = await officeA.post("/quotes", {
    client_id: clientId, job_type: JOB_TYPE, quoted_hours: 6, quoted_materials: 320,
  });
  if (quote.status === 201) ok("quotes: create quote");
  else { fail("quotes: create quote", `status ${quote.status}`); return finish(); }
  const quoteId = quote.json.id;

  const lines = await officeA.patch(`/quotes/${quoteId}/lines`, {
    lines: [{ description: "Painel de distribuição RJ45 (linha da proposta)", qty: 1, unit_price: 62 }],
  });
  if (lines.status === 200 && lines.json.lines?.length === 1) ok("quotes: BOM line added");
  else { fail("quotes: BOM line added", `status ${lines.status} ${JSON.stringify(lines.json)}`); return finish(); }

  // No system checklist/execution template matches this job_type's slug, so
  // create tenant-owned ones first (same reason/pattern phase2-proof.mjs
  // uses) — test_protocol deliberately is NOT set up this way: it resolves
  // by network_type (inferred "PC" from "estruturada"), straight through to
  // seed.sql's real, already-verified F11 system template.
  await createAndActivateTemplate(officeA, {
    kind: "checklist",
    code: `readiness_${SLUG}`,
    title: "Readiness — cablagem estruturada (Phase 3 proof)",
    body: {
      items: [
        { cat: "material", label: "Painel de distribuição RJ45", qty: 1, scope: "job", mandatory: true },
        { cat: "equipment", label: "Certificador de cablagem estruturada", qty: 1, scope: "job", mandatory: true },
        { cat: "equipment", label: "Kit de ferramentas do técnico verificado", qty: 1, scope: "van", mandatory: true },
        { cat: "doc", label: "Termo de responsabilidade assinado", qty: 1, scope: "office", mandatory: true },
      ],
    },
  });
  ok("templates: checklist template created and activated");

  await createAndActivateTemplate(officeA, {
    kind: "execution_steps",
    code: `execution_${SLUG}`,
    title: "Execução — cablagem estruturada (Phase 3 proof)",
    body: {
      steps: [
        { order: 0, label: "Passagem e fixação de cablagem" },
        { order: 1, label: "Certificação de cada ligação (EN 50173 Classe E)" },
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

  if (createJob.json.has_test_protocol_snapshot) {
    ok("create-job: test_protocol_snapshot resolved (network_type PC, F11)");
  } else {
    fail("create-job: test_protocol_snapshot resolved for a PC job_type", JSON.stringify(createJob.json));
    return finish();
  }

  const jobAfterCreate = await officeA.get(`/jobs/${jobId}`);
  const resolvedProtocol = jobAfterCreate.json?.test_protocol_snapshot;
  const resolvedReturnLoss = resolvedProtocol?.tests?.find((t) => t.id === EXPECTED_F11_TEST_CODE);
  const matchesSeededF11 =
    resolvedProtocol?.network_type === EXPECTED_F11_NETWORK_TYPE &&
    resolvedReturnLoss?.dir === "external_pass_fail" &&
    resolvedReturnLoss?.limit_ref === EXPECTED_F11_LIMIT_REF;
  if (matchesSeededF11) {
    ok("create-job: test_protocol_snapshot resolved from the real seed.sql F11 system template (network_type PC, external_pass_fail dir)");
  } else {
    fail("create-job: test_protocol_snapshot matches seed.sql's F11 system template", JSON.stringify(resolvedProtocol));
  }

  // ==== Satisfy the dispatch gate (same four conditions as Phase 2) ======

  const readiness = await officeA.get(`/jobs/${jobId}/readiness`);
  const items = readiness.json?.items ?? [];

  const mandatoryJobItems = items.filter((i) => i.scope === "job" && i.mandatory && i.status !== "ok");
  for (const item of mandatoryJobItems) {
    const mutation = {
      client_mutation_id: crypto.randomUUID(),
      type: "checklist_item.update",
      job_id: jobId,
      payload: { item_id: item.id, status: "ok" },
      occurred_at: new Date().toISOString(),
    };
    const res = await technician.post("/sync/mutations", { mutations: [mutation] });
    if (res.json?.results?.[0]?.status !== "applied") fail("sync: checklist_item.update applies", JSON.stringify(res.json));
  }
  const nonJobItems = items.filter((i) => i.scope !== "job");
  for (const item of nonJobItems) {
    await officeA.patch(`/jobs/${jobId}/checklist/${item.id}`, { status: "ok" });
  }
  ok(`checklist: ${mandatoryJobItems.length} job-scope + ${nonJobItems.length} van/office-scope items marked ok`);

  const vanAudit = await technician.post("/van-audits", { van_label: "VAN-01", issues: [] });
  if (vanAudit.status === 201 && vanAudit.json?.next_due_at) ok("van-audits: fresh audit recorded");
  else fail("van-audits: fresh audit recorded", `status ${vanAudit.status} ${JSON.stringify(vanAudit.json)}`);

  // Classify existing_alteration — the safe, over-inclusive default per PRD
  // §7/CLAUDE.md, applied by office review (never the technician).
  const classify = await officeA.patch(`/jobs/${jobId}`, { ited_classification: "existing_alteration" });
  if (classify.status === 200 && classify.json?.ited_classification_by) {
    ok("jobs: office classifies existing_alteration (stamps ited_classification_by)");
  } else {
    fail("jobs: office classifies existing_alteration", `status ${classify.status} ${JSON.stringify(classify.json)}`);
  }

  const dispatch = await officeA.post(`/jobs/${jobId}/dispatch`);
  if (dispatch.status === 200 && dispatch.json?.test_protocol_snapshot != null) {
    ok("dispatch: succeeds, snapshots present");
  } else {
    fail("dispatch: succeeds", `status ${dispatch.status} ${JSON.stringify(dispatch.json)}`);
    return finish();
  }

  await technician.post(`/jobs/${jobId}/execution-steps/0/complete`);
  await technician.post(`/jobs/${jobId}/execution-steps/1/complete`);
  ok("execution-steps: both steps completed");

  // ==== 4. test_result.record, capture_source manual, external_pass_fail =

  const directTestResult = await technician.post(`/jobs/${jobId}/test-results`, {
    network_type: "PC",
    location_label: "Rack técnico",
    test_code: EXPECTED_F11_TEST_CODE,
    measured_value: "pass",
    capture_source: "manual",
  });
  if (directTestResult.status === 200 && directTestResult.json?.outcome === "pass") {
    ok("test-results: direct HTTP route evaluates dir='external_pass_fail' -> outcome='pass' (new evalTest branch, over real HTTP)");
  } else {
    fail("test-results: external_pass_fail outcome", `status ${directTestResult.status} ${JSON.stringify(directTestResult.json)}`);
  }

  // ==== 5. Complete + closeout -> termo compliance_deadline ==============

  const complete = await technician.post(`/jobs/${jobId}/complete`);
  if (complete.status === 200 && complete.json?.completed_at) ok("jobs: complete stamps completed_at");
  else { fail("jobs: complete", `status ${complete.status} ${JSON.stringify(complete.json)}`); return finish(); }
  const completedAt = complete.json.completed_at;

  const closeout = await technician.post(`/jobs/${jobId}/closeout`, {
    first_time_fix: true,
    technician_note_transcript: "Cablagem estruturada certificada, todos os parâmetros dentro da Classe E.",
  });
  if (closeout.status === 200 && closeout.json?.first_time_fix === true) {
    ok("jobs: technician closeout (first_time_fix: true)");
  } else {
    fail("jobs: technician closeout", `status ${closeout.status} ${JSON.stringify(closeout.json)}`);
  }

  const deadlinesAfterCloseout = await officeA.get(`/compliance/deadlines?status=open`);
  const termoDeadline = (deadlinesAfterCloseout.json ?? []).find(
    (d) => d.job_id === jobId && d.kind === "termo"
  );
  if (termoDeadline) {
    const expectedTermoDueOn = isoDate(addWorkingDaysExpected(new Date(completedAt), 10, {}));
    if (normalizeDueOn(termoDeadline.due_on) === expectedTermoDueOn) {
      ok(`compliance: termo deadline created (due_on ${termoDeadline.due_on}), matches an independently-computed PT working-day calendar`);
    } else {
      fail("compliance: termo deadline due_on matches independent calculation",
        `got ${termoDeadline.due_on}, expected ${expectedTermoDueOn}`);
    }
  } else {
    fail("compliance: termo deadline exists after closeout", JSON.stringify(deadlinesAfterCloseout.json));
  }

  // ==== 6. F15 — REF assembly, generate-pdf, real object-store file ======

  const createRef = await officeA.post(`/jobs/${jobId}/ref`, {});
  if (createRef.status === 201 && createRef.json?.ref_id) {
    ok(`ref: POST /jobs/:id/ref creates ref_document (ref_id ${createRef.json.ref_id})`);
  } else {
    fail("ref: create ref_document", `status ${createRef.status} ${JSON.stringify(createRef.json)}`);
    return finish();
  }
  const refId = createRef.json.ref_id;

  const patchRef = await officeA.patch(`/jobs/${jobId}/ref`, {
    ficha_fields: { building: { postal_code: "1000-001", locality: "Lisboa", address: createRef.json.ficha_fields.building.address, manual_ited_applicable: createRef.json.ficha_fields.building.manual_ited_applicable } },
  });
  if (patchRef.status === 200 && patchRef.json?.ficha_fields?.building?.postal_code === "1000-001") {
    ok("ref: PATCH /jobs/:id/ref merges ficha_fields.building.postal_code");
  } else {
    fail("ref: PATCH ficha_fields", `status ${patchRef.status} ${JSON.stringify(patchRef.json)}`);
  }

  const generatePdf = await officeA.post(`/jobs/${jobId}/ref/generate-pdf`, {});
  const pdfKey = generatePdf.json?.generated_pdf;
  if (generatePdf.status === 200 && pdfKey) {
    ok(`ref: POST /jobs/:id/ref/generate-pdf returns a generated_pdf key (${pdfKey})`);
  } else {
    fail("ref: generate-pdf returns a key", `status ${generatePdf.status} ${JSON.stringify(generatePdf.json)}`);
  }
  if (pdfKey) {
    const objectPath = path.join(RUNTIME_DIR, "objects", pdfKey);
    if (existsSync(objectPath)) {
      ok(`ref: generated PDF file actually exists on the object store's disk location (${objectPath})`);
    } else {
      fail("ref: generated PDF exists on disk", `expected file at ${objectPath}`);
    }
  }

  // ==== 7. F16 — termo, reconciliation gate, REF compliance_deadline =====

  const mismatchedTermo = await officeA.post(`/jobs/${jobId}/termo`, {
    number: "TERMO-0001",
    ref_id_field: "REF-DOES-NOT-MATCH",
    issued_at: TERMO_ISSUED_AT,
  });
  if (mismatchedTermo.status === 422 && mismatchedTermo.json?.error === "ref_termo_mismatch") {
    ok("termo: mismatched ref_id_field rejected with 422 ref_termo_mismatch (DB trigger surfaced cleanly)");
  } else {
    fail("termo: mismatched ref_id_field rejected", `status ${mismatchedTermo.status} ${JSON.stringify(mismatchedTermo.json)}`);
  }

  const correctTermo = await officeA.post(`/jobs/${jobId}/termo`, {
    number: "TERMO-0001",
    ref_id_field: refId,
    issued_at: TERMO_ISSUED_AT,
  });
  if (correctTermo.status === 201 && correctTermo.json?.ref_id_field === refId) {
    ok("termo: matching ref_id_field accepted (201)");
  } else {
    fail("termo: matching ref_id_field accepted", `status ${correctTermo.status} ${JSON.stringify(correctTermo.json)}`);
    return finish();
  }

  const deadlinesAfterTermo = await officeA.get(`/compliance/deadlines`);
  const refDeadline = (deadlinesAfterTermo.json ?? []).find((d) => d.job_id === jobId && d.kind === "ref");
  if (refDeadline) {
    const gotDueOn = normalizeDueOn(refDeadline.due_on);
    if (gotDueOn === EXPECTED_REF_DUE_ON && gotDueOn !== NAIVE_REF_DUE_ON_WOULD_BE) {
      ok(`compliance: ref deadline due_on=${gotDueOn} is holiday-aware — correctly skips Sexta-Feira Santa (2026-04-03), disagreeing with the naive weekday-only answer (${NAIVE_REF_DUE_ON_WOULD_BE})`);
    } else {
      fail("compliance: ref deadline due_on is holiday-aware",
        `got ${gotDueOn}, expected ${EXPECTED_REF_DUE_ON} (naive would be ${NAIVE_REF_DUE_ON_WOULD_BE})`);
    }
  } else {
    fail("compliance: ref deadline exists after termo issued", JSON.stringify(deadlinesAfterTermo.json));
  }

  // ==== 8. compliance_profile='basic' tenant is 403'd on every route =====

  const basicJobId = crypto.randomUUID(); // never reached — the profile gate fires before any job lookup, confirmed by reading routes/ref.ts and routes/termo.ts directly
  const basicChecks = [
    ["POST", `/jobs/${basicJobId}/ref`, {}],
    ["PATCH", `/jobs/${basicJobId}/ref`, { rotulo_affixed: true }],
    ["POST", `/jobs/${basicJobId}/ref/generate-pdf`, {}],
    ["POST", `/jobs/${basicJobId}/termo`, { number: "X", ref_id_field: "X", issued_at: TERMO_ISSUED_AT }],
    ["PATCH", `/jobs/${basicJobId}/termo/recipients/anacom`, { sent_at: TERMO_ISSUED_AT }],
    ["POST", `/jobs/${basicJobId}/termo/paper-copy-photo`, {}],
    ["GET", `/compliance/deadlines`, undefined],
  ];
  let basicAll403 = true;
  for (const [method, p, body] of basicChecks) {
    const res = await officeB.req(method, p, body);
    if (res.status !== 403 || res.json?.error !== "compliance_profile_basic") {
      basicAll403 = false;
      fail(`compliance: basic tenant 403 on ${method} ${p}`, `status ${res.status} ${JSON.stringify(res.json)}`);
    }
  }
  if (basicAll403) {
    ok(`compliance: every REF/termo/deadline route 403s compliance_profile_basic for tenant B (${basicChecks.length} routes checked)`);
  }

  await finish();
}

async function finish() {
  await killServerHard();
  console.log("\n" + (failures === 0
    ? "All Phase 3 exit-criterion checks passed."
    : `${failures} check(s) failed — see FAIL lines above.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Proof script crashed:", err);
  await killServerHard();
  process.exit(1);
});
