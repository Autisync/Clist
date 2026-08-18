// Phase 1 exit-criterion proof (CLAUDE.md / architecture §8):
//
//   "two tenants' data provably isolated, one offline mutation round-trips
//   correctly after an app kill"
//
// Exercised through the real, running HTTP API — not by calling internal
// functions — because that's the only way "provably isolated" and "round-
// trips correctly" mean anything. The server runs as a real child process
// so step 4 below can SIGKILL it and restart against the same on-disk
// PGlite data, which is what "surviving a killed-mid-sync app restart"
// actually requires proving.
//
// Usage: npm run proof   (from apps/api, or via the root proof:phase1 script)

import { spawn } from "node:child_process";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
// Deliberately NOT under REPO_ROOT — see apps/api/src/runtime-dir.ts for
// why (the mounted repo folder doesn't reliably support unlinking PGlite's
// on-disk files). This is the one dir this whole proof owns and can
// freely rm -rf.
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-proof");
const FIXTURES_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");
const PORT = 3911;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "phase1-proof-fixed-secret"; // fixed across restart so a live cookie stays valid

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// rather than imported so this script has zero build step (plain Node,
// no tsx) and can run standalone against a running or freshly-spawned API.
const CREDS = {
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
  officeBEmail: "owner@concorrente.pt",
  officeBPassword: "proof-pass-456",
};

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail}`); }

// ---- tiny cookie-jar HTTP client, one per "device" ------------------------

class Session {
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

// ---- run ---------------------------------------------------------------

async function main() {
  console.log(`Clean slate: removing ${RUNTIME_DIR}`);
  rmSync(RUNTIME_DIR, { recursive: true, force: true });

  console.log("Starting API (first boot — applies schema/seed/fixtures)...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server booted and /health is green");

  if (!existsSync(FIXTURES_PATH)) {
    fail("fixtures file present", `expected at ${FIXTURES_PATH}`);
    return finish();
  }
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
  ok("fixtures loaded");

  // ---- 1. Auth: both flows -------------------------------------------

  const officeA = new Session();
  const badLogin = await officeA.post("/auth/office/login", {
    email: CREDS.officeAEmail, password: "wrong-password",
  });
  if (badLogin.status === 401) ok("auth: wrong office password rejected");
  else fail("auth: wrong office password rejected", `status ${badLogin.status}`);

  const loginA = await officeA.post("/auth/office/login", {
    email: CREDS.officeAEmail, password: CREDS.officeAPassword,
  });
  if (loginA.status === 200) ok("auth: office A login succeeds");
  else fail("auth: office A login succeeds", `status ${loginA.status} ${JSON.stringify(loginA.json)}`);

  const officeB = new Session();
  const loginB = await officeB.post("/auth/office/login", {
    email: CREDS.officeBEmail, password: CREDS.officeBPassword,
  });
  if (loginB.status === 200) ok("auth: office B login succeeds");
  else fail("auth: office B login succeeds", `status ${loginB.status}`);

  const pair = await officeA.post("/auth/technician/pair", {
    inviteToken: fixtures.officeAId, deviceLabel: "Proof phone", pin: "9999",
  });
  if (pair.status === 201 && pair.json?.device_id) ok("auth: technician device pairing succeeds");
  else fail("auth: technician device pairing succeeds", `status ${pair.status} ${JSON.stringify(pair.json)}`);

  const technician = new Session();
  const techLogin = await technician.post("/auth/technician/login", {
    deviceId: pair.json.device_id, pin: "9999",
  });
  if (techLogin.status === 200) ok("auth: technician PIN login succeeds");
  else fail("auth: technician PIN login succeeds", `status ${techLogin.status}`);

  const techRevokeAttempt = await technician.post(`/auth/technician/revoke/${pair.json.device_id}`);
  if (techRevokeAttempt.status === 403) ok("auth: technician cannot call office-only revoke");
  else fail("auth: technician cannot call office-only revoke", `status ${techRevokeAttempt.status}`);

  // ---- 2. Tenant isolation, over HTTP, through the real API -----------

  const createTpl = await officeA.post("/templates", {
    kind: "checklist", code: "proof_isolation_check", title: "Proof isolation check",
  });
  if (createTpl.status === 201) ok("isolation: office A creates a tenant-owned template");
  else fail("isolation: office A creates a tenant-owned template", `status ${createTpl.status}`);
  const privateTemplateId = createTpl.json?.id;

  const listA = await officeA.get("/templates");
  const aSeesOwn = listA.json?.templates?.some((t) => t.id === privateTemplateId);
  const aSeesSystem = listA.json?.templates?.filter((t) => t.layer === "system").length >= 2;
  if (aSeesOwn && aSeesSystem) ok("isolation: office A sees its own template + system templates");
  else fail("isolation: office A sees its own template + system templates", JSON.stringify(listA.json));

  const listB = await officeB.get("/templates");
  const bSeesAsPrivate = listB.json?.templates?.some((t) => t.id === privateTemplateId);
  const bSeesSystem = listB.json?.templates?.filter((t) => t.layer === "system").length >= 2;
  if (!bSeesAsPrivate && bSeesSystem) {
    ok("isolation: office B does NOT see tenant A's private template, but DOES see system templates");
  } else {
    fail("isolation: tenant B view", `sawPrivate=${bSeesAsPrivate} sawSystem=${bSeesSystem}`);
  }

  // ---- 3. Template activation gate, over HTTP --------------------------

  const createProtocol = await officeA.post("/templates", {
    kind: "test_protocol", code: "proof_test_protocol", title: "Proof test protocol",
  });
  const protocolId = createProtocol.json?.id;
  const draftVersion = await officeA.post(`/templates/${protocolId}/versions`, {
    body: { network_type: "FO", tests: [{ id: "t", label: "Test", unit: "dB", dir: "max", max: 1.8, limit_ref: "Proof" }] },
  });
  if (draftVersion.status === 201) ok("gate: draft test_protocol version created");
  else fail("gate: draft test_protocol version created", `status ${draftVersion.status} ${JSON.stringify(draftVersion.json)}`);

  const unverifiedActivate = await officeA.post(
    `/templates/${protocolId}/versions/${draftVersion.json.version}/activate`, {}
  );
  if (unverifiedActivate.status === 422 && unverifiedActivate.json?.error === "unverified_test_protocol") {
    ok("gate: activating an unverified test_protocol is rejected with 422 over HTTP");
  } else {
    fail("gate: unverified activation rejected", `status ${unverifiedActivate.status} ${JSON.stringify(unverifiedActivate.json)}`);
  }

  const verifiedActivate = await officeA.post(
    `/templates/${protocolId}/versions/${draftVersion.json.version}/activate`,
    { verified_by: fixtures.officeAId, verified_source: "Phase 1 proof citation" }
  );
  if (verifiedActivate.status === 200) ok("gate: a verified test_protocol activates cleanly over HTTP");
  else fail("gate: verified activation succeeds", `status ${verifiedActivate.status} ${JSON.stringify(verifiedActivate.json)}`);

  // ---- 4. Offline sync: apply, kill server, restart, replay -----------

  const mutationId1 = crypto.randomUUID();
  const batch1 = {
    mutations: [{
      client_mutation_id: mutationId1,
      type: "checklist_item.update",
      job_id: fixtures.jobId,
      payload: { item_id: fixtures.checklistItemId, status: "ok" },
      occurred_at: new Date().toISOString(),
    }],
  };
  const sync1 = await technician.post("/sync/mutations", batch1);
  const applied1 = sync1.json?.results?.[0];
  if (applied1?.status === "applied") ok("sync: trivial checklist mutation applies");
  else fail("sync: trivial checklist mutation applies", JSON.stringify(sync1.json));

  const read1 = await technician.get(`/jobs/${fixtures.jobId}/readiness`);
  const read1Item = read1.json?.items?.find((i) => i.id === fixtures.checklistItemId);
  if (read1Item?.status === "ok") ok("sync: underlying row reflects the mutation ('ok')");
  else fail("sync: underlying row reflects the mutation", JSON.stringify(read1.json));

  console.log("  ...  killing the server (SIGKILL) to simulate a crash mid-sync");
  await killServerHard();
  ok("server process killed");

  console.log("  ...  restarting against the same on-disk data");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server restarted and reconnected to the same PGlite data directory");

  // Same technician cookie, minted before the kill — proves a device that
  // was mid-sync when the app died doesn't need to re-authenticate to
  // finish the retry, matching the real field scenario.
  const sync1Replay = await technician.post("/sync/mutations", batch1);
  const replayed = sync1Replay.json?.results?.[0];
  if (replayed?.status === "already_applied") {
    ok("sync: replaying the identical batch after restart returns already_applied (idempotent)");
  } else {
    fail("sync: idempotent replay after restart", JSON.stringify(sync1Replay.json));
  }

  const read2 = await technician.get(`/jobs/${fixtures.jobId}/readiness`);
  const read2Item = read2.json?.items?.find((i) => i.id === fixtures.checklistItemId);
  if (read2Item?.status === "ok") ok("sync: replay did not double-apply or revert the row");
  else fail("sync: replay left row unchanged", JSON.stringify(read2.json));

  const mutationId2 = crypto.randomUUID();
  const sync2 = await technician.post("/sync/mutations", {
    mutations: [{
      client_mutation_id: mutationId2,
      type: "checklist_item.update",
      job_id: fixtures.jobId,
      payload: { item_id: fixtures.checklistItemId, status: "missing" },
      occurred_at: new Date().toISOString(),
    }],
  });
  if (sync2.json?.results?.[0]?.status === "applied") {
    ok("sync: a genuinely new mutation after restart still applies (server fully functional, not just idempotent)");
  } else {
    fail("sync: new mutation after restart applies", JSON.stringify(sync2.json));
  }

  await finish();
}

async function finish() {
  await killServerHard();
  console.log("\n" + (failures === 0
    ? "All Phase 1 exit-criterion checks passed."
    : `${failures} check(s) failed — see FAIL lines above.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Proof script crashed:", err);
  await killServerHard();
  process.exit(1);
});
