// apps/web end-to-end smoke test — same rigor and pattern as
// apps/api/test/phase1-proof.mjs / phase2-proof.mjs: spawn the REAL API
// and the REAL built Next.js app as child processes, drive them over real
// HTTP with a cookie jar, prove the plumbing actually works. Not a browser-
// engine test (that needs a real rendering engine) — this proves the part
// most likely to be silently broken: server-side cookie forwarding through
// Server Components, and the /api/* rewrite-proxy carrying auth cookies
// correctly end to end, which is the riskiest new piece of infrastructure
// apps/web adds on top of the already-proven API.
//
// Usage: node apps/web/test/smoke.mjs  (or npm run smoke:web from the root)

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
// Resolve the real `next` binary directly rather than going through `npx`.
// `npx next start` makes npx the parent and next-server a grandchild --
// SIGKILLing the npx PID (killHard()'s whole mechanism) does not reliably
// take the grandchild with it, so it survives as an orphan (reparented to
// PID 1) squatting on WEB_PORT. Confirmed happening in practice: it let a
// later run's own spawn silently validate against a stale leftover server
// instead of the one it just started. Spawning the binary directly makes
// it the immediate child SIGKILL actually reaches.
// npm workspaces hoist shared deps' bin symlinks to the repo root's
// node_modules/.bin, not into apps/web/node_modules/.bin.
const NEXT_BIN = path.join(REPO_ROOT, "node_modules/.bin/next");
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-smoke-web");
const API_PORT = 3913;
const WEB_PORT = 3005;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
const JWT_SECRET = "smoke-web-fixed-secret";

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// the same way the other proof scripts do, so this runs standalone with no
// build step of its own.
const CREDS = {
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
};

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail}`); }

// ---- tiny cookie-jar HTTP client -------------------------------------

class Session {
  cookie = null;
  async req(method, base, p, body, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (body !== undefined && !opts.raw) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(base + p, {
      method,
      headers,
      body: body === undefined ? undefined : opts.raw ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookie.length > 0) this.cookie = setCookie[0].split(";")[0];
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (an HTML page) */ }
    return { status: res.status, json, text };
  }
  get(base, p) { return this.req("GET", base, p); }
  post(base, p, body, opts) { return this.req("POST", base, p, body, opts); }
  patch(base, p, body) { return this.req("PATCH", base, p, body); }
}

// ---- process lifecycle -------------------------------------------------

let apiProc = null;
let webProc = null;

function spawnApi() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/index.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PORT: String(API_PORT),
          SESSION_JWT_SECRET: JWT_SECRET,
          FIELDREADY_RUNTIME_DIR: RUNTIME_DIR,
          LOG: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let settled = false;
    proc.stdout.on("data", (d) => {
      if (!settled && d.toString().includes("listening on")) { settled = true; resolve(proc); }
    });
    proc.stderr.on("data", (d) => process.stderr.write(`[api] ${d}`));
    proc.on("exit", (code) => { if (!settled) reject(new Error(`api exited early with code ${code}`)); });
    setTimeout(() => { if (!settled) reject(new Error("api did not report ready in time")); }, 15000);
  });
}

function spawnWeb() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      NEXT_BIN,
      ["start", "-p", String(WEB_PORT)],
      {
        cwd: path.join(REPO_ROOT, "apps/web"),
        env: {
          ...process.env,
          FIELDREADY_API_ORIGIN: API_BASE,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let settled = false;
    const onData = (d) => {
      const s = d.toString();
      process.stderr.write(`[web] ${s}`);
      if (!settled && /Ready in|started server/i.test(s)) { settled = true; resolve(proc); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => { if (!settled) reject(new Error(`web exited early with code ${code}`)); });
    setTimeout(() => { if (!settled) reject(new Error("web did not report ready in time")); }, 30000);
  });
}

async function waitForHealth(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200 || res.status === 404) return; // any real response = server is up
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} never responded`);
}

function killHard(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once("exit", () => resolve());
    proc.kill("SIGKILL");
  });
}

// ---- run -----------------------------------------------------------------

async function main() {
  console.log(`Clean slate: removing ${RUNTIME_DIR}`);
  rmSync(RUNTIME_DIR, { recursive: true, force: true });

  console.log("Building apps/web (production build)...");
  // FIELDREADY_API_ORIGIN must be set for THIS build step, not just for
  // `next start` later: next.config.ts's rewrites() destination gets
  // resolved into the build output at `next build` time, not read fresh at
  // request time. Building without it silently bakes in the default
  // (127.0.0.1:3001) regardless of what env var `next start` gets — this
  // bit the first version of this script (ECONNREFUSED on the real
  // apps/api port, which was never 3001 here), so it's called out
  // explicitly rather than left as an implicit assumption.
  await new Promise((resolve, reject) => {
    const build = spawn(NEXT_BIN, ["build"], {
      cwd: path.join(REPO_ROOT, "apps/web"),
      env: { ...process.env, FIELDREADY_API_ORIGIN: API_BASE },
      stdio: "inherit",
    });
    build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed (${code})`))));
  });
  ok("apps/web production build succeeds");

  console.log("Starting API...");
  apiProc = await spawnApi();
  await waitForHealth(`${API_BASE}/health`);
  ok("API booted and /health is green");

  console.log("Starting Next.js (production)...");
  webProc = await spawnWeb();
  await waitForHealth(`${WEB_BASE}/login`);
  ok("web app booted and serving");

  const office = new Session();

  // ---- 1. Office login page + real login through the proxy -------------

  const loginPage = await office.get(WEB_BASE, "/login");
  // apps/web/src/app/login/page.tsx wraps its form in <Suspense fallback={null}>
  // (required for useSearchParams) — the raw server-rendered HTML from a
  // plain HTTP GET legitimately contains an empty fallback, not the form
  // itself, until client-side JS hydrates. That's correct Next.js behavior,
  // confirmed by reading the page source, not a bug — so this check only
  // proves the route serves a real HTML document (not a 404/500/empty
  // response), same bar as the rest of the route-existence checks below.
  // The form actually working end to end is proven by the very next check
  // (a real login through this exact page's own API call).
  if (loginPage.status === 200 && /<!DOCTYPE html>/i.test(loginPage.text)) ok("GET /login serves the app shell (200, real HTML)");
  else fail("GET /login serves the app shell", `status ${loginPage.status}`);

  // The login page's Client Component POSTs JSON straight to /api/auth/office/login
  // (via the rewrite proxy) — hit that same path directly, exactly as the browser does.
  const login = await office.post(WEB_BASE, "/api/auth/office/login", {
    email: CREDS.officeAEmail, password: CREDS.officeAPassword,
  });
  if (login.status === 200 && office.cookie) ok("POST /api/auth/office/login through the proxy sets a session cookie");
  else fail("office login through proxy", `status ${login.status} ${JSON.stringify(login.json)}`);

  const jobsPage = await office.get(WEB_BASE, "/office/jobs");
  if (jobsPage.status === 200 && !/Acesso ao escrit/i.test(jobsPage.text)) {
    ok("GET /office/jobs with the session cookie renders (not bounced back to login) — proves Server Component cookie forwarding works");
  } else {
    fail("server-side cookie forwarding to /office/jobs", `status ${jobsPage.status}`);
  }

  // ---- 2. Full quote -> job creation through the proxy -------------------

  const client = await office.post(WEB_BASE, "/api/clients", { name: "Smoke Test Client" });
  const clientId = client.json?.id;
  if (client.status === 201 && clientId) ok("create client through proxy");
  else fail("create client through proxy", `status ${client.status}`);

  const quote = await office.post(WEB_BASE, "/api/quotes", {
    client_id: clientId, job_type: "TDT novo", quoted_hours: 2, quoted_materials: 100,
  });
  const quoteId = quote.json?.id;
  if (quote.status === 201 && quoteId) ok("create quote through proxy");
  else fail("create quote through proxy", `status ${quote.status}`);

  await office.patch(WEB_BASE, `/api/quotes/${quoteId}/lines`, {
    lines: [{ description: "Kit", qty: 1, unit_price: 50 }],
  });
  await office.post(WEB_BASE, `/api/quotes/${quoteId}/accept`, {});
  const createJob = await office.post(WEB_BASE, `/api/quotes/${quoteId}/create-job`, {});
  const jobId = createJob.json?.id;
  if (createJob.status === 201 && jobId) ok("create-job through proxy");
  else fail("create-job through proxy", `status ${createJob.status} ${JSON.stringify(createJob.json)}`);

  const jobDetailPage = await office.get(WEB_BASE, `/office/jobs/${jobId}`);
  if (jobDetailPage.status === 200 && createJob.json?.code && jobDetailPage.text.includes(createJob.json.code)) {
    ok("GET /office/jobs/:id renders the real job code — server-rendered from live API data");
  } else {
    fail("job detail page renders real data", `status ${jobDetailPage.status}`);
  }

  // ---- 3. Technician pairing + PIN login through the proxy ---------------

  const officeIdRow = await office.get(API_BASE, `/jobs/${jobId}`); // just to confirm API reachable directly too
  if (officeIdRow.status !== 200) fail("direct API still reachable", `status ${officeIdRow.status}`);

  // Pairing needs the office user's own id as inviteToken (Phase 1's
  // documented simplification) — fetch it via the fixtures file the API
  // wrote on first boot, same as the other proof scripts do.
  const fixtures = JSON.parse(
    await import("node:fs").then((fs) => fs.readFileSync(path.join(RUNTIME_DIR, "phase1-fixtures.json"), "utf8"))
  );

  const pair = await office.post(WEB_BASE, "/api/auth/technician/pair", {
    inviteToken: fixtures.officeAId, deviceLabel: "Smoke phone", pin: "4321",
  });
  const deviceId = pair.json?.device_id;
  if (pair.status === 201 && deviceId) ok("pair technician device through proxy");
  else fail("pair technician device through proxy", `status ${pair.status} ${JSON.stringify(pair.json)}`);

  const technician = new Session();
  const techLogin = await technician.post(WEB_BASE, "/api/auth/technician/login", { deviceId, pin: "4321" });
  if (techLogin.status === 200 && technician.cookie) ok("technician PIN login through proxy");
  else fail("technician PIN login through proxy", `status ${techLogin.status}`);

  const fieldHome = await technician.get(WEB_BASE, "/field/home");
  if (fieldHome.status === 200) ok("GET /field/home with technician cookie renders");
  else fail("GET /field/home renders", `status ${fieldHome.status}`);

  for (const route of ["prep", "prep-result", "site", "tests", "voice", "done"]) {
    const r = await technician.get(WEB_BASE, `/field/jobs/${jobId}/${route}`);
    if (r.status === 200) ok(`GET /field/jobs/:id/${route} renders (200)`);
    else fail(`GET /field/jobs/:id/${route} renders`, `status ${r.status}`);
  }

  // ---- 4. PWA shell files --------------------------------------------

  const manifest = await technician.get(WEB_BASE, "/manifest.json");
  if (manifest.status === 200 && manifest.json?.name === "FieldReady") ok("GET /manifest.json is valid");
  else fail("GET /manifest.json", `status ${manifest.status}`);

  const sw = await technician.get(WEB_BASE, "/sw.js");
  if (sw.status === 200) ok("GET /sw.js is served");
  else fail("GET /sw.js", `status ${sw.status}`);

  // ---- 5. The exact sync contract offline-queue.ts relies on -----------

  const mutationId = crypto.randomUUID();
  const readiness = await technician.get(WEB_BASE, `/api/jobs/${jobId}/readiness`);
  const itemId = readiness.json?.items?.[0]?.id;
  if (!itemId) {
    fail("readiness has a checklist item to mutate", JSON.stringify(readiness.json));
  } else {
    const batch = {
      mutations: [{
        client_mutation_id: mutationId,
        type: "checklist_item.update",
        job_id: jobId,
        payload: { item_id: itemId, status: "ok" },
        occurred_at: new Date().toISOString(),
      }],
    };
    const sync1 = await technician.post(WEB_BASE, "/api/sync/mutations", batch);
    const applied = sync1.json?.results?.[0];
    if (applied?.status === "applied") {
      ok("POST /api/sync/mutations through the web app's proxy applies — proves the exact contract offline-queue.ts depends on works end to end");
    } else {
      fail("sync mutation through proxy applies", JSON.stringify(sync1.json));
    }

    const sync2 = await technician.post(WEB_BASE, "/api/sync/mutations", batch);
    const replayed = sync2.json?.results?.[0];
    if (replayed?.status === "already_applied") ok("replaying the identical batch through the proxy returns already_applied (idempotent)");
    else fail("idempotent replay through proxy", JSON.stringify(sync2.json));
  }

  await finish();
}

async function finish() {
  await killHard(webProc);
  await killHard(apiProc);
  console.log("\n" + (failures === 0
    ? "All apps/web smoke checks passed."
    : `${failures} check(s) failed — see FAIL lines above.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Smoke test crashed:", err);
  await killHard(webProc);
  await killHard(apiProc);
  process.exit(1);
});
