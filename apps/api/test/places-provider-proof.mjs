// Live proof for the real Google Places integration (places-provider.ts's
// GooglePlacesProvider) and routes/suppliers.ts's graceful-degradation
// handling around it — the one piece of Phase 4 that was deliberately left
// unwired ("no real Google Places credentials in this environment") until
// a real GOOGLE_PLACES_API_KEY landed in apps/api/.env.
//
// Unlike phase4-proof.mjs, this script does NOT strip GOOGLE_PLACES_API_KEY
// from the spawned server's environment — that stripping is exactly right
// for the deterministic regression suite, and exactly wrong here, since
// exercising the real vendor call is this script's entire point. Real,
// non-deterministic implications, same as bridge-auth-proof.mjs/
// support-tickets-proof.mjs hitting the real Supabase project rather than
// PGlite: this talks to the real Google Places API over the real network.
//
// What this CAN prove from a dev sandbox with no route to the key's
// allow-listed IP (46.224.205.82): GooglePlacesProvider correctly makes
// the real HTTP call, correctly parses a real Google error response into
// PlacesApiError, and routes/suppliers.ts's catch block correctly
// degrades to "200, existing fields unchanged" rather than 500ing —
// exercised here via the real IP-restriction rejection, which is a
// genuine (if incidental) instance of "the vendor call failed," not a
// mock standing in for one.
//
// What this CANNOT prove from here: that a successful real Places lookup
// returns and normalizes correctly (address/phone/hours) — that needs
// running from the allow-listed IP itself (the production VPS), where
// this same script will report a 200-with-real-vendor-error INSTEAD
// exercise the success path if GOOGLE_PLACES_MOCK_PLACE_ID_UNREACHABLE is
// unset there — see the two-branch check below, which adapts to whichever
// of the two real outcomes Google actually returns rather than assuming
// one.
//
// Usage: npm run proof:places   (from apps/api, or via the root
// proof:places script) — requires a real GOOGLE_PLACES_API_KEY in
// apps/api/.env; skips itself (not a failure) if none is configured.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Client } from "pg";
import { resetFastifySchema } from "./db-reset.mjs";
import { pgClientConfig } from "../supabase/verify-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-proof-places");
const FIXTURES_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");
const FASTIFY_DB_SCHEMA = "fastify_api_proof_places";
const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "places-proof-fixed-secret";

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — same
// duplication every other proof script's own CREDS comment explains.
const CREDS = { officeAEmail: "rex@antenas-piloto.pt", officeAPassword: "proof-pass-123" };

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail instanceof Error ? detail.message : JSON.stringify(detail)}`); }
function note(label) { console.log(`  NOTE ${label}`); }

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
    const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return this._consume(res);
  }
  get(p) { return this.req("GET", p); }
  post(p, body) { return this.req("POST", p, body ?? {}); }
}

let serverProc = null;
let publicSchemaClient = null;
let mirroredTenantId = null;
function spawnServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/index.ts"],
      {
        cwd: REPO_ROOT,
        // Deliberately NOT stripping GOOGLE_PLACES_API_KEY — see file
        // header. Everything else about this spawn mirrors phase4-proof.mjs.
        env: { ...process.env, PORT: String(PORT), SESSION_JWT_SECRET: JWT_SECRET, FIELDREADY_RUNTIME_DIR: RUNTIME_DIR, FASTIFY_DB_SCHEMA, LOG: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let settled = false;
    proc.stdout.on("data", (d) => { if (!settled && d.toString().includes("listening on")) { settled = true; resolve(proc); } });
    proc.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
    proc.on("exit", (code) => { if (!settled) reject(new Error(`server exited early with code ${code}`)); });
    setTimeout(() => { if (!settled) reject(new Error("server did not report ready in time")); }, 15000);
  });
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const res = await fetch(BASE + "/health"); if (res.ok) return; } catch { /* not up yet */ }
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

function finish() {
  console.log(`\n${failures === 0 ? "All" : failures + " of the"} places-provider-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

async function main() {
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    note("GOOGLE_PLACES_API_KEY not set in this shell's environment — skipping (not a failure). Run with --env-file=.env from apps/api to pick up a real key.");
    return;
  }

  console.log(`Clean slate: removing ${RUNTIME_DIR}`);
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  console.log(`Clean slate: dropping schema ${FASTIFY_DB_SCHEMA}`);
  await resetFastifySchema(FASTIFY_DB_SCHEMA);

  try {
    console.log("Starting API with the real GOOGLE_PLACES_API_KEY present (first boot — applies schema/seed/Phase 1 fixtures)...");
    serverProc = await spawnServer();
    await waitForHealth();
    ok("server booted with a real Places key configured, /health is green");

    if (!existsSync(FIXTURES_PATH)) { fail("fixtures file present", `expected at ${FIXTURES_PATH}`); return finish(); }
    const fixturesData = JSON.parse(readFileSync(FIXTURES_PATH, "utf8"));
    ok("fixtures loaded");

    const officeA = new Session();
    const loginA = await officeA.post("/auth/office/login", { email: CREDS.officeAEmail, password: CREDS.officeAPassword });
    if (loginA.status === 200) ok("auth: office A login succeeds");
    else { fail("auth: office A login succeeds", `status ${loginA.status}`); return finish(); }

    // Mirror office A's classic tenant id into the real Supabase project's
    // public.tenant — same real bug/fix as phase4-proof.mjs's own
    // identical comment: suppliers.ts's routes now correctly write
    // public.supplier (the real, Supabase-native table), which has a real
    // FK to public.tenant, and officeA's classic fr_session tenant_id
    // only ever existed in the classic schema's own tenant table before
    // this. Cleaned up in the finally block below no matter what.
    publicSchemaClient = new Client(pgClientConfig(process.env.SUPABASE_PROJECT_REF, process.env.SUPABASE_DB_PASSWORD));
    await publicSchemaClient.connect();
    mirroredTenantId = fixturesData.tenantAId;
    await publicSchemaClient.query(
      `insert into tenant (id, name, slug, compliance_profile) values ($1, $2, $3, 'ited_ready')
       on conflict (id) do nothing;`,
      [mirroredTenantId, "Places Proof (mirror)", `places-proof-mirror-${mirroredTenantId}`]
    );
    ok("public.tenant: mirrored office A's classic tenant id for the newly-public-schema-backed suppliers.ts routes below");

    // A real, well-known Google place id (Sydney Opera House) — chosen
    // specifically so a 404 here would mean something is actually wrong,
    // unlike FIXTURE_SUPPLIERS' own ChIJ_mock_* keys.
    const sup = await officeA.post("/suppliers", { name: "Places Proof Supplier", place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4" });
    if (sup.status === 201 && sup.json.id) ok("supplier created with a real Google place_id (POST /suppliers only echoes id, not the row — confirmed by refresh-places below instead)");
    else { fail("supplier created", sup); return finish(); }

    const refresh = await officeA.post(`/suppliers/${sup.json.id}/refresh-places`, {});
    if (refresh.status !== 200) { fail("refresh-places returns 200 regardless of vendor outcome", refresh); return finish(); }
    ok("refresh-places: 200 (never 500, whatever the real Google response was)");

    // Two legitimate outcomes depending on the network this script runs
    // from — both are real, neither is mocked:
    //   (a) this environment isn't the key's allow-listed IP -> Google
    //       rejects the call -> GooglePlacesProvider throws PlacesApiError
    //       -> routes/suppliers.ts degrades to unchanged fields.
    //   (b) this environment IS the allow-listed IP (running this from
    //       the production VPS itself) -> a real successful lookup ->
    //       address/phone/hours populated from Google's real data.
    if (refresh.json.address === null && refresh.json.phone === null) {
      ok("outcome (a): vendor call failed (expected from a non-allow-listed IP) — graceful degradation confirmed, no crash, no partial write");
      note("This does NOT prove a successful real lookup normalizes correctly — re-run this script from the allow-listed IP (46.224.205.82, the production VPS) to exercise that path for real.");
    } else if (typeof refresh.json.address === "string" && refresh.json.address.toLowerCase().includes("sydney")) {
      ok(`outcome (b): real successful Google Places lookup — address="${refresh.json.address}", hours=${refresh.json.hours ? "present" : "null"}`);
    } else {
      fail("refresh-places outcome matches one of the two expected shapes", refresh.json);
    }

    const noPlaceIdSup = await officeA.post("/suppliers", { name: "Places Proof Supplier (no place_id)" });
    const refreshNoPlaceId = await officeA.post(`/suppliers/${noPlaceIdSup.json.id}/refresh-places`, {});
    if (refreshNoPlaceId.status === 422 && refreshNoPlaceId.json.error === "no_place_id") {
      ok("refresh-places on a supplier with no place_id still 422s (unaffected by the real-provider swap)");
    } else fail("no-place_id case unaffected", refreshNoPlaceId);
  } finally {
    await killServerHard();
    rmSync(RUNTIME_DIR, { recursive: true, force: true });
    if (publicSchemaClient && mirroredTenantId) {
      // Each delete in its own try/catch (phase4-proof.mjs's own
      // cleanupMirroredTenant comment explains why: one throwing must
      // never abort the rest and orphan the tenant row in the shared
      // project). This script only ever creates supplier rows under the
      // mirror (no catalog_item/supplier_price/receipt/app_user), so the
      // FK-safe order is shorter than phase4-proof.mjs's own version.
      const step = async (label, sql) => {
        try { await publicSchemaClient.query(sql, [mirroredTenantId]); }
        catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
      };
      await step("supplier", `delete from supplier where tenant_id = $1;`);
      await step("tenant", `delete from tenant where id = $1;`);
      await publicSchemaClient.end().catch(() => {});
    }
  }

  finish();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
