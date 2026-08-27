// Phase 4 exit-criterion proof (07-phase4-cost-intelligence.md §7):
//
//   the five /dashboard/* endpoints return figures computed from live data
//   (via the views 03-schema.sql §13/§13a already ships) rather than
//   anything hardcoded, and the sourcing/pickup-plan logic reproduces the
//   prototype's cheapest-open-supplier-first ordering exactly.
//
// Same shape as apps/api/test/phase1/2/3-proof.mjs: a real child-process
// server, a cookie-jar Session per "device", real HTTP only. Own
// RUNTIME_DIR and own fixed port (3915) so this proof can run
// independently of, or back to back with, phase1/2/3's.
//
// Usage: npm run proof:phase4   (from apps/api, or via the root
// proof:phase4 script)

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { Client } from "pg";
import { resetFastifySchema, openDirectConnection } from "./db-reset.mjs";
import { pgClientConfig } from "../supabase/verify-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");
const RUNTIME_DIR = path.join(os.tmpdir(), "fieldready-proof-phase4");
const FIXTURES_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");
// Real-Postgres swap: db.ts now persists into a real Postgres schema, not
// an on-disk PGlite directory — this proof's own dedicated schema.
const FASTIFY_DB_SCHEMA = "fastify_api_proof_phase4";
const PORT = 3915;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "phase4-proof-fixed-secret"; // fixed across restart so a live cookie stays valid (same reason phase1/3-proof.mjs's own comment gives)

// Must match apps/api/src/fixtures.ts's PHASE1_FIXTURES — duplicated here
// for the same "zero build step, plain node, no tsx" reason every other
// proof script's own CREDS comment gives. Tenant A is seeded 'ited_ready'
// (non-basic), which is irrelevant to this phase's routes (none of
// suppliers/catalog/receipts/sourcing/pickup-plan/dashboard gate on
// compliance_profile — only Phase 3's REF/termo/deadline routes do) but
// does mean the job loop below needs one PATCH /jobs/:id ited_classification
// call per job, same as phase2/3-proof.mjs already do.
const CREDS = {
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
};

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, detail) { failures++; console.log(`  FAIL ${label} -> ${detail}`); }
function note(label) { console.log(`  NOTE ${label}`); }

const round1 = (n) => Math.round(n * 10) / 10;

// ---- tiny cookie-jar HTTP client, one per "device" -------------------------

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

  // Multipart upload (04-API-SPEC.md §3 receipts, 05-phase2-job-loop.md §7
  // photos) — no content-type header set here on purpose, same reason
  // phase2-proof.mjs's own postForm comment gives: fetch's FormData sets
  // its own multipart boundary, which a hardcoded "application/json" would
  // break.
  async postForm(p, formData) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(BASE + p, { method: "POST", headers, body: formData });
    return this._consume(res);
  }
}

// ---- server process lifecycle ----------------------------------------------

let serverProc = null;
// Real Supabase connection + the mirrored tenant id (see main()'s own
// comment on why this exists) -- module-level so finish() and the outer
// catch handler can both clean it up regardless of which exit path runs.
let publicSchemaClient = null;
let mirroredTenantId = null;
// Direct connection into the CLASSIC schema (db-reset.mjs's own
// openDirectConnection) -- the flip side of the tenant/app_user mirror:
// catalog items created via the now-public-schema-backed POST
// /catalog-items also need a same-id row in the CLASSIC catalog_item
// table, because job_checklist_item (still a classic-schema concept for
// this proof's own pickup-plan job) has its own FK to the classic
// catalog_item, unrelated to public.catalog_item entirely.
let classicSchemaClient = null;

function spawnServer() {
  return new Promise((resolve, reject) => {
    // Strip any VERYFI_* credentials from the inherited environment before
    // spawning -- this proof must always exercise FixtureReceiptOcrProvider
    // (receipt-ocr-provider.ts's deterministic, no-network stand-in), never
    // the real vendor, regardless of what happens to be exported in
    // whichever shell runs this script. Real Veryfi calls are slow,
    // rate-limited, cost money, and non-deterministic -- none of which this
    // proof can tolerate. This must stay true even if apps/api/.env ever
    // gets auto-loaded by some future change to how the server boots.
    const env = { ...process.env };
    delete env.VERYFI_CLIENT_ID;
    delete env.VERYFI_CLIENT_SECRET;
    delete env.VERYFI_USERNAME;
    delete env.VERYFI_API_KEY;
    // Same reasoning, same treatment, for the real Google Places key
    // (places-provider.ts) now that one is configured in apps/api/.env --
    // this proof must always exercise FixturePlacesProvider, never the
    // real, network-dependent, IP-restricted vendor call.
    delete env.GOOGLE_PLACES_API_KEY;

    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "apps/api/src/index.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ...env,
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
// duplicated here for the same zero-build-step reason phase2/3-proof.mjs's
// own copies already are.
function slugify(input) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// POSTs /catalog-items (now public-schema-backed, catalog.ts's own fix)
// AND mirrors the same id/sku/name into the CLASSIC schema's own
// catalog_item table via classicSchemaClient -- see main()'s comment on
// classicSchemaClient for why: job_checklist_item (still classic for this
// proof's pickup-plan job) FKs to the classic catalog_item, entirely
// unrelated to public.catalog_item. Every catalog item this proof creates
// goes through this helper now, not a bare officeA.post, so both schemas
// always agree on the id even for items that turn out not to need the
// classic side (harmless — an extra, unused row in an isolated,
// per-run-dropped classic schema).
async function createCatalogItemMirrored(session, sku, name) {
  const res = await session.post("/catalog-items", { sku, name });
  if (res.status === 201) {
    await classicSchemaClient.query(
      `insert into catalog_item (id, tenant_id, sku, name) values ($1, $2, $3, $4)
       on conflict (id) do nothing;`,
      [res.json.id, mirroredTenantId, sku, name]
    );
  }
  return res;
}

// Creates a template of `kind`, publishes one version with `body`, and
// activates it. Ported verbatim from phase2/3-proof.mjs.
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

// Builds a supplier.hours jsonb array (03-schema.sql §5 comment /
// packages/core/src/supplier.ts SupplierHours: one slot|null per index,
// index == JS Date#getDay()) that is guaranteed open right now, computed
// from the wall clock the *server* will evaluate openState against — both
// this script and the spawned server run on the same host, so `new Date()`
// here and there agree. A wide (+/-90min) window keeps this robust against
// the few seconds this proof takes to run, short of the literal midnight
// edge (same acknowledged, deliberately-not-engineered-around risk
// phase3-proof.mjs's own TERMO_ISSUED_AT comment accepts for a different
// wall-clock dependency).
function openNowHours(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const clamp = (mins) => Math.max(0, Math.min(23 * 60 + 59, mins));
  const fmt = (mins) => { const m = clamp(mins); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();
  const hours = [null, null, null, null, null, null, null];
  hours[dow] = { dow, open: fmt(nowMin - 90), close: fmt(nowMin + 90) };
  return hours;
}

// Never open, any day — deterministic "closed" regardless of wall clock.
function alwaysClosedHours() {
  return [null, null, null, null, null, null, null];
}

// A 1x1 transparent PNG — a tiny, real, decodable image (ported verbatim
// from phase2-proof.mjs), for the multipart receipt upload.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

  // Mirror office A's CLASSIC tenant id into the real Supabase project's
  // public.tenant — real bug, found and fixed the same session as
  // suppliers.ts/catalog.ts/receipts.ts/domain/sourcing.ts's own versions
  // of it: those files now correctly write/read public.catalog_item/
  // public.supplier/public.supplier_price (the real, Supabase-native
  // tables apps/web actually uses), which have a real FK to public.tenant.
  // officeA authenticates via the classic fr_session cookie, whose
  // tenant_id only ever existed in the classic schema's OWN tenant table
  // -- inserting through the newly-fixed routes below would otherwise
  // 23503 foreign-key-violate on every single catalog/supplier/price/
  // receipt/sourcing call in this section. This mirror row, with the
  // SAME id, satisfies that FK for the classic-authenticated session
  // without switching this whole section to a real Supabase Auth bridge
  // session — the classic job/checklist data these same fixtures feed
  // into (pickup-plan below, still a classic-schema concept) still needs
  // the classic tenant id to be the one requireAuth resolves either way.
  // Deleted in finish() (both success and failure paths) — never left
  // behind in the shared project.
  publicSchemaClient = new Client(pgClientConfig(process.env.SUPABASE_PROJECT_REF, process.env.SUPABASE_DB_PASSWORD));
  await publicSchemaClient.connect();
  mirroredTenantId = fixtures.tenantAId;
  await publicSchemaClient.query(
    `insert into tenant (id, name, slug, compliance_profile) values ($1, $2, $3, 'ited_ready')
     on conflict (id) do nothing;`,
    [mirroredTenantId, "Phase 4 Proof (mirror)", `phase4-proof-mirror-${mirroredTenantId}`]
  );
  // Also mirrors office A's own app_user id -- supplier_price.created_by /
  // receipt.confirmed_by both FK to app_user(id), and this classic
  // session's req.auth!.user_id only ever existed in the classic schema's
  // own app_user table. auth_user_id stays null (this mirror row never
  // signs in for real -- the classic fr_session cookie is the only
  // credential this proof ever uses), which is fine: that column is
  // nullable exactly for technician-shaped rows, and nothing here reads it.
  await publicSchemaClient.query(
    `insert into app_user (id, tenant_id, role, full_name, email) values ($1, $2, 'owner', $3, $4)
     on conflict (id) do nothing;`,
    [fixtures.officeAId, mirroredTenantId, "Phase 4 Proof (mirror)", `phase4-proof-mirror-${fixtures.officeAId}@example.invalid`]
  );
  ok("public.tenant/app_user: mirrored office A's classic ids for the newly-public-schema-backed routes below");

  classicSchemaClient = await openDirectConnection(FASTIFY_DB_SCHEMA);

  // ==== 1. Seed suppliers/catalog-items/prices, including a >3% rise =====

  const catAlpha = await createCatalogItemMirrored(officeA, "ALPHA-SRC-001", "Item Alpha — sourcing");
  const catGamma = await createCatalogItemMirrored(officeA, "GAMMA-ALERT-001", "Item Gamma — price alert");
  if (catAlpha.status === 201 && catGamma.status === 201) ok("catalog-items: created (Alpha, Gamma)");
  else { fail("catalog-items: created", `${catAlpha.status} ${catGamma.status}`); return finish(); }
  const itemAlphaId = catAlpha.json.id;
  const itemGammaId = catGamma.json.id;

  const supCheap = await officeA.post("/suppliers", { name: "Fornecedor Barato Lda" });
  const supMid = await officeA.post("/suppliers", { name: "Fornecedor Médio Lda" });
  const supExpensive = await officeA.post("/suppliers", { name: "Fornecedor Caro Lda" });
  const supRiser = await officeA.post("/suppliers", { name: "Fornecedor Subida Lda" });
  const supCheapAlt = await officeA.post("/suppliers", { name: "Fornecedor Alternativo Barato Lda" });
  const supplierCreates = [supCheap, supMid, supExpensive, supRiser, supCheapAlt];
  if (supplierCreates.every((r) => r.status === 201)) ok("suppliers: 5 created (Cheap/Mid/Expensive/Riser/CheapAlt)");
  else { fail("suppliers: created", JSON.stringify(supplierCreates.map((r) => r.status))); return finish(); }

  // Item Alpha: 3 supplier prices, no rises — pure ascending-order fixture
  // for step 3 below.
  await officeA.post(`/suppliers/${supCheap.json.id}/prices`, { item_id: itemAlphaId, price: 5.0, source: "manual" });
  await officeA.post(`/suppliers/${supMid.json.id}/prices`, { item_id: itemAlphaId, price: 8.0, source: "manual" });
  await officeA.post(`/suppliers/${supExpensive.json.id}/prices`, { item_id: itemAlphaId, price: 12.0, source: "manual" });
  ok("suppliers: Item Alpha priced at 3 suppliers (5.00 / 8.00 / 12.00)");

  // Item Gamma: supRiser's price rises 10.00 -> 11.00 (+10%, > the 3%
  // v_price_alerts threshold), supCheapAlt supplies a cheaper alternative
  // (9.00) for the dashboard's "alt" join.
  const gammaFirst = await officeA.post(`/suppliers/${supRiser.json.id}/prices`, { item_id: itemGammaId, price: 10.0, source: "manual" });
  const gammaRise = await officeA.post(`/suppliers/${supRiser.json.id}/prices`, { item_id: itemGammaId, price: 11.0, source: "manual" });
  await officeA.post(`/suppliers/${supCheapAlt.json.id}/prices`, { item_id: itemGammaId, price: 9.0, source: "manual" });
  if (gammaFirst.status === 201 && gammaRise.status === 201 && Number(gammaRise.json.prev_price) === 10) {
    ok("suppliers: Item Gamma price rise seeded (10.00 -> 11.00, prev_price recorded)");
  } else {
    fail("suppliers: Item Gamma price rise seeded", `${gammaFirst.status} ${gammaRise.status} ${JSON.stringify(gammaRise.json)}`);
  }

  // ==== 2. Receipts: OCR-stub lines, one unmatched, selective confirm ====

  const catCabo = await createCatalogItemMirrored(officeA, "CABO-RG6-100", "Cabo coaxial RG6 (bobine 100m)");
  const catConector = await createCatalogItemMirrored(officeA, "CONECTOR-F-COMP", "Conector F compressão");
  if (catCabo.status === 201 && catConector.status === 201) ok("catalog-items: created matching the fixture OCR provider's known lines");
  else { fail("catalog-items: created for receipt match", `${catCabo.status} ${catConector.status}`); return finish(); }

  const supReceipt = await officeA.post("/suppliers", { name: "Rexel Alfragide (proof)" });
  const supplierReceiptId = supReceipt.json.id;

  const receiptForm = new FormData();
  receiptForm.append("supplier_id", supplierReceiptId);
  receiptForm.append("doc_number", "FT 2026/PROOF-01");
  const pngBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
  receiptForm.append("file", new Blob([pngBuffer], { type: "image/png" }), "receipt.png");
  const receiptRes = await officeA.postForm("/receipts", receiptForm);
  if (receiptRes.status !== 201) {
    fail("receipts: POST /receipts (multipart)", `status ${receiptRes.status} ${JSON.stringify(receiptRes.json)}`);
    return finish();
  }
  const receiptId = receiptRes.json.id;
  const receiptLines = receiptRes.json.lines ?? [];
  if (receiptLines.length === 3) ok("receipts: 3 receipt_line rows appear (fixture ReceiptOcrProvider's 3 lines)");
  else fail("receipts: 3 receipt_line rows appear", JSON.stringify(receiptLines));

  const caboLine = receiptLines.find((l) => l.description === "Cabo coaxial RG6 (bobine 100m)");
  const conectorLine = receiptLines.find((l) => l.description === "Conector F compressão");
  const diversoLine = receiptLines.find((l) => l.description === "Material diverso (ver talão)");
  if (caboLine?.item_id === catCabo.json.id && conectorLine?.item_id === catConector.json.id) {
    ok("receipts: matched lines carry the real catalog_item item_id (case-insensitive name match)");
  } else {
    fail("receipts: matched lines carry item_id", JSON.stringify({ caboLine, conectorLine }));
  }
  if (diversoLine && diversoLine.item_id === null) {
    ok("receipts: unmatched line ('Material diverso') has item_id = null — the 'sem correspondência' case");
  } else {
    fail("receipts: unmatched line has item_id = null", JSON.stringify(diversoLine));
  }

  // Confirm only the Cabo line — Conector (matched, but not confirmed) and
  // Material diverso (unmatched) must NOT become supplier_price rows.
  const confirm = await officeA.post(`/receipts/${receiptId}/confirm`, { line_ids: [caboLine.id] });
  if (confirm.status === 200 && (confirm.json.supplier_prices ?? []).length === 1) {
    ok("receipts: confirm with a subset (1 of 3 line_ids) writes exactly 1 supplier_price row");
  } else {
    fail("receipts: confirm subset writes exactly 1 row", `status ${confirm.status} ${JSON.stringify(confirm.json)}`);
  }

  const pricesAfterConfirm = await officeA.get(`/suppliers/${supplierReceiptId}/prices`);
  const confirmedRows = pricesAfterConfirm.json?.prices ?? [];
  const hasCabo = confirmedRows.some((r) => r.item_id === catCabo.json.id && Number(r.price) === 42.5 && r.source === "receipt");
  const hasConector = confirmedRows.some((r) => r.item_id === catConector.json.id);
  if (confirmedRows.length === 1 && hasCabo && !hasConector) {
    ok("suppliers: GET /suppliers/:id/prices shows exactly the confirmed Cabo line (42.50, source=receipt) — Conector (matched, unconfirmed) absent");
  } else {
    fail("suppliers: prices reflect only the confirmed line", JSON.stringify(confirmedRows));
  }

  // ==== 3. GET /catalog-items/:id/sourcing — strictly ascending price ====

  const sourcing = await officeA.get(`/catalog-items/${itemAlphaId}/sourcing`);
  const options = sourcing.json?.options ?? [];
  const prices = options.map((o) => o.price);
  const strictlyAscending = prices.length === 3 && prices.every((p, i) => i === 0 || p > prices[i - 1]);
  if (strictlyAscending && prices[0] === 5 && prices[2] === 12) {
    ok(`sourcing: 3 supplier prices for Item Alpha returned strictly ascending (${JSON.stringify(prices)})`);
  } else {
    fail("sourcing: strictly ascending price order", JSON.stringify(prices));
  }

  // ==== 3b. GET /suppliers/places-search — the autocomplete automation, ==
  // ====     against FixturePlacesProvider (this proof strips
  // ====     GOOGLE_PLACES_API_KEY, spawnServer's own comment) — the one
  // ====     deterministic, always-run test of the fixture search path;
  // ====     places-provider-proof.mjs's own search test only ever runs
  // ====     against the real vendor, and skips itself entirely without a
  // ====     real key configured.
  {
    const search = await officeA.get(`/suppliers/places-search?q=Rexel`);
    const names = (search.json?.results ?? []).map((r) => r.name);
    if (search.status === 200 && names.length === 1 && names[0] === "Rexel Alfragide") {
      ok("places-search (fixture): substring match against the fixture's known suppliers returns exactly the matching one");
    } else fail("places-search fixture match", search);
  }
  {
    const noMatch = await officeA.get(`/suppliers/places-search?q=NoSuchSupplierXYZ`);
    if (noMatch.status === 200 && Array.isArray(noMatch.json?.results) && noMatch.json.results.length === 0) {
      ok("places-search (fixture): no match degrades to an empty result list, not an error");
    } else fail("places-search fixture no-match", noMatch);
  }
  {
    const tooShort = await officeA.get(`/suppliers/places-search?q=re`);
    if (tooShort.status === 200 && Array.isArray(tooShort.json?.results) && tooShort.json.results.length === 0) {
      ok("places-search (fixture): a query under 3 characters short-circuits to an empty result list");
    } else fail("places-search fixture short-query short-circuit", tooShort);
  }

  // ==== 4. GET /jobs/:id/pickup-plan — (coverage, open-now, price) tuple =

  const catPickupA = await createCatalogItemMirrored(officeA, "PICKUP-A", "Peça Pickup A");
  const catPickupB = await createCatalogItemMirrored(officeA, "PICKUP-B", "Peça Pickup B");
  const itemPickupAId = catPickupA.json.id;
  const itemPickupBId = catPickupB.json.id;

  const supBothOpen = await officeA.post("/suppliers", { name: "Fornecedor Ambos Aberto Lda", hours: openNowHours() });
  const supBothClosed = await officeA.post("/suppliers", { name: "Fornecedor Ambos Fechado Lda", hours: alwaysClosedHours() });
  const supOnlyA = await officeA.post("/suppliers", { name: "Fornecedor Só A Lda", hours: openNowHours() });
  const supOnlyB = await officeA.post("/suppliers", { name: "Fornecedor Só B Lda", hours: openNowHours() });
  if ([supBothOpen, supBothClosed, supOnlyA, supOnlyB].every((r) => r.status === 201)) {
    ok("suppliers: 4 pickup-plan fixture suppliers created (2 covering both items, 2 covering one each)");
  } else {
    fail("suppliers: pickup-plan fixture suppliers created", "");
    return finish();
  }

  // Both1 (open): 10.00 + 10.00 = 20.00. Both2 (closed): 5.00 + 5.00 = 10.00
  // — cheaper total, but coverage ties with Both1, so open-now must still
  // rank Both1 first. OnlyA/OnlyB (open, coverage 1) are unambiguously
  // cheaper individually but rank behind both coverage-2 suppliers.
  await officeA.post(`/suppliers/${supBothOpen.json.id}/prices`, { item_id: itemPickupAId, price: 10.0, source: "manual" });
  await officeA.post(`/suppliers/${supBothOpen.json.id}/prices`, { item_id: itemPickupBId, price: 10.0, source: "manual" });
  await officeA.post(`/suppliers/${supBothClosed.json.id}/prices`, { item_id: itemPickupAId, price: 5.0, source: "manual" });
  await officeA.post(`/suppliers/${supBothClosed.json.id}/prices`, { item_id: itemPickupBId, price: 5.0, source: "manual" });
  await officeA.post(`/suppliers/${supOnlyA.json.id}/prices`, { item_id: itemPickupAId, price: 1.0, source: "manual" });
  await officeA.post(`/suppliers/${supOnlyB.json.id}/prices`, { item_id: itemPickupBId, price: 2.0, source: "manual" });
  ok("suppliers: pickup-plan fixture prices seeded (Both-open=20.00, Both-closed=10.00, OnlyA=1.00, OnlyB=2.00)");

  const pickupClient = await officeA.post("/clients", { name: "Cliente Pickup-Plan Proof" });
  const pickupClientId = pickupClient.json.id;
  const JOB_TYPE_PICKUP = "Reposição de material avulso — Phase 4 proof";
  const SLUG_PICKUP = slugify(JOB_TYPE_PICKUP);

  const pickupQuote = await officeA.post("/quotes", {
    client_id: pickupClientId, job_type: JOB_TYPE_PICKUP, quoted_hours: 2, quoted_materials: 20,
  });
  const pickupQuoteId = pickupQuote.json.id;

  await createAndActivateTemplate(officeA, {
    kind: "checklist",
    code: `readiness_${SLUG_PICKUP}`,
    title: "Readiness — pickup-plan proof",
    body: {
      items: [
        { cat: "material", label: "Peça Pickup A", qty: 1, item_id: itemPickupAId, scope: "job", mandatory: true },
        { cat: "material", label: "Peça Pickup B", qty: 1, item_id: itemPickupBId, scope: "job", mandatory: true },
      ],
    },
  });
  ok("templates: pickup-plan checklist template created and activated (2 mandatory job-scope materials)");

  await officeA.post(`/quotes/${pickupQuoteId}/accept`);
  const pickupCreateJob = await officeA.post(`/quotes/${pickupQuoteId}/create-job`);
  if (pickupCreateJob.status !== 201) {
    fail("quotes: create-job (pickup-plan job)", `status ${pickupCreateJob.status} ${JSON.stringify(pickupCreateJob.json)}`);
    return finish();
  }
  const pickupJobId = pickupCreateJob.json.id;
  ok("quotes: pickup-plan job created — 2 mandatory materials left status='missing' on purpose, never dispatched");

  const pickupPlanRes = await officeA.get(`/jobs/${pickupJobId}/pickup-plan`);
  const plan = pickupPlanRes.json?.plan ?? [];
  const names = plan.map((e) => e.supplier.name);
  const expectedOrder = [
    "Fornecedor Ambos Aberto Lda",
    "Fornecedor Ambos Fechado Lda",
    "Fornecedor Só A Lda",
    "Fornecedor Só B Lda",
  ];
  const orderMatches = JSON.stringify(names) === JSON.stringify(expectedOrder);
  const totalsMatch =
    plan[0]?.items?.length === 2 && plan[0]?.total === 20 && plan[0]?.state?.open === true &&
    plan[1]?.items?.length === 2 && plan[1]?.total === 10 && plan[1]?.state?.open === false &&
    plan[2]?.items?.length === 1 && plan[2]?.total === 1 &&
    plan[3]?.items?.length === 1 && plan[3]?.total === 2;
  if (orderMatches && totalsMatch) {
    ok("pickup-plan: order matches hand-computed (coverage desc, open-now desc, total price asc) — Both-open(20,open) > Both-closed(10,closed) > OnlyA(1) > OnlyB(2)");
  } else {
    fail("pickup-plan: order matches hand-computed tuple", JSON.stringify(plan.map((e) => ({
      name: e.supplier.name, items: e.items?.length, total: e.total, open: e.state?.open,
    }))));
  }

  // ==== 5/6. Dashboard — two closed jobs feeding first-time-fix-rate and =
  // ====      hours-variance, plus the price-alerts join from step 1 ======

  const dashClient = await officeA.post("/clients", { name: "Cliente Dashboard Proof" });
  const dashClientId = dashClient.json.id;

  // Two distinct job_types, n=1 each, so avg_hours_delta/avg_pct_variance
  // is exactly that one job's own delta — no averaging arithmetic needed
  // to hand-verify the expectation. actual_hours has no HTTP write path in
  // this build (confirmed: grep for actual_hours across apps/api/src turns
  // up only the SELECT in routes/jobs.ts and the verify-schema.mjs direct
  // SQL seed) — set below via a direct connection into the same Postgres
  // schema the server uses, the same "reachable the same way
  // verify-schema.mjs is" direct-SQL pattern that file's own actual_hours
  // insert already establishes, run only after the server is killed so
  // there is never more than one thing touching that schema at once.
  const JOB_TYPE_HV1 = "Reparação de equipamento diverso — Alpha";
  const JOB_TYPE_HV2 = "Reparação de equipamento diverso — Beta";
  const hvJobs = [
    { jobType: JOB_TYPE_HV1, quotedHours: 4, actualHours: 5, firstTimeFix: true },
    { jobType: JOB_TYPE_HV2, quotedHours: 10, actualHours: 8, firstTimeFix: false },
  ];

  const closedJobIds = [];
  for (const spec of hvJobs) {
    const slug = slugify(spec.jobType);
    const quote = await officeA.post("/quotes", {
      client_id: dashClientId, job_type: spec.jobType, quoted_hours: spec.quotedHours, quoted_materials: 50,
    });
    if (quote.status !== 201) { fail(`quotes: create quote (${spec.jobType})`, `status ${quote.status}`); return finish(); }

    await createAndActivateTemplate(officeA, {
      kind: "checklist",
      code: `readiness_${slug}`,
      title: `Readiness — ${spec.jobType} (Phase 4 proof)`,
      body: { items: [{ cat: "material", label: "Peça genérica", qty: 1, scope: "job", mandatory: true }] },
    });

    await officeA.post(`/quotes/${quote.json.id}/accept`);
    const createJob = await officeA.post(`/quotes/${quote.json.id}/create-job`);
    if (createJob.status !== 201) { fail(`quotes: create-job (${spec.jobType})`, `status ${createJob.status} ${JSON.stringify(createJob.json)}`); return finish(); }
    const jobId = createJob.json.id;

    const readiness = await officeA.get(`/jobs/${jobId}/readiness`);
    const jobItems = (readiness.json?.items ?? []).filter((i) => i.scope === "job" && i.mandatory);
    for (const item of jobItems) {
      await officeA.patch(`/jobs/${jobId}/checklist/${item.id}`, { status: "ok" });
    }

    // Tenant A is compliance_profile='ited_ready' — dispatch condition (d)
    // requires an explicit office review even for the safe default
    // (CLAUDE.md / PRD §7), same as phase3-proof.mjs.
    await officeA.patch(`/jobs/${jobId}`, { ited_classification: "existing_alteration" });

    const dispatch = await officeA.post(`/jobs/${jobId}/dispatch`);
    if (dispatch.status !== 200) { fail(`dispatch: ${spec.jobType}`, `status ${dispatch.status} ${JSON.stringify(dispatch.json)}`); return finish(); }

    const complete = await officeA.post(`/jobs/${jobId}/complete`);
    if (complete.status !== 200) { fail(`jobs: complete (${spec.jobType})`, `status ${complete.status}`); return finish(); }

    const closeout = await officeA.post(`/jobs/${jobId}/closeout`, {
      first_time_fix: spec.firstTimeFix,
      technician_note_transcript: `Phase 4 proof — ${spec.jobType}.`,
    });
    if (closeout.status !== 200) { fail(`jobs: closeout (${spec.jobType})`, `status ${closeout.status}`); return finish(); }

    closedJobIds.push(jobId);
  }
  ok(`jobs: 2 jobs (distinct job_types) walked through dispatch -> complete -> closeout`);

  // ---- price-alerts + recommended-actions + readiness-correlation, while =
  // ---- the server is still up (no actual_hours dependency) ---------------

  const priceAlerts = await officeA.get("/dashboard/price-alerts");
  const alerts = priceAlerts.json?.alerts ?? [];
  const gammaAlert = alerts.find((a) => a.item_id === itemGammaId);
  if (
    gammaAlert &&
    gammaAlert.supplier_id === supRiser.json.id &&
    gammaAlert.price === 11 &&
    gammaAlert.prev_price === 10 &&
    gammaAlert.delta_pct === 10 &&
    gammaAlert.alt?.supplier_id === supCheapAlt.json.id &&
    gammaAlert.alt?.price === 9
  ) {
    ok("dashboard/price-alerts: Item Gamma's 10.00->11.00 rise present with delta_pct=10.0 and the correct cheaper alt (9.00, CheapAlt)");
  } else {
    fail("dashboard/price-alerts: Item Gamma rise + alt correct", JSON.stringify(gammaAlert));
  }

  const readinessCorr = await officeA.get("/dashboard/readiness-correlation");
  if (readinessCorr.status === 200 && Array.isArray(readinessCorr.json?.buckets)) {
    ok("dashboard/readiness-correlation: 200, reads v_readiness_correlation");
  } else {
    fail("dashboard/readiness-correlation: 200 with buckets array", `status ${readinessCorr.status}`);
  }

  const recommended = await officeA.get("/dashboard/recommended-actions");
  const actions = recommended.json?.actions ?? [];
  const validPriorities = actions.every((a) => ["Alta", "Média", "Baixa"].includes(a.priority));
  const hasSupplierSwitch = actions.some((a) => a.title.includes("Fornecedor Alternativo Barato") || a.why.includes("Fornecedor Alternativo Barato"));
  if (recommended.status === 200 && validPriorities && hasSupplierSwitch) {
    ok("dashboard/recommended-actions: 200, valid priority vocabulary, includes the Item Gamma supplier-switch sentence generated from live data");
  } else {
    fail("dashboard/recommended-actions: 200, valid priorities, supplier-switch action present", JSON.stringify(actions));
  }

  // ---- kill the server, write actual_hours directly (no HTTP route ------
  // ---- exists for it), independently re-derive the expected dashboard ---
  // ---- numbers via raw SQL, then restart and compare over HTTP ----------

  await killServerHard();
  ok("server killed (SIGKILL) before any direct DB access — never two things touching the same schema at once");

  const directDb = await openDirectConnection(FASTIFY_DB_SCHEMA);

  const jobRows = await directDb.query(
    `select id, job_type, quoted_hours from job where id = any($1::uuid[]);`,
    [closedJobIds]
  );
  const byType = new Map(jobRows.rows.map((r) => [r.job_type, r]));
  for (const spec of hvJobs) {
    const row = byType.get(spec.jobType);
    if (!row) { fail(`direct-db: job row found for ${spec.jobType}`, "not found"); continue; }
    await directDb.query(`update job set actual_hours = $1 where id = $2;`, [spec.actualHours, row.id]);
  }
  ok("direct-db: actual_hours written directly (verify-schema.mjs's own seed pattern for this same column)");

  // Independent re-derivation #1: hours-variance, computed in JS from raw
  // job rows — not by re-reading v_hours_variance, so a broken view or a
  // hardcoded route handler would both be caught.
  const hvRawRows = await directDb.query(
    `select job_type, quoted_hours, actual_hours from job
     where tenant_id = $1 and job_type = any($2::text[]) and actual_hours is not null;`,
    [fixtures.tenantAId, [JOB_TYPE_HV1, JOB_TYPE_HV2]]
  );
  const expectedHoursVariance = new Map();
  for (const r of hvRawRows.rows) {
    const quoted = Number(r.quoted_hours);
    const actual = Number(r.actual_hours);
    expectedHoursVariance.set(r.job_type, {
      n: 1,
      avg_hours_delta: round1(actual - quoted),
      avg_pct_variance: round1((100 * (actual - quoted)) / quoted),
    });
  }
  note(`direct-db: independently computed hours-variance expectation ${JSON.stringify(Object.fromEntries(expectedHoursVariance))}`);

  // Independent re-derivation #2: first-time-fix-rate for the current
  // month, computed in JS from raw job_closeout rows.
  const ffrRawRows = await directDb.query(
    `select jc.first_time_fix, jc.closed_at
     from job_closeout jc join job j on j.id = jc.job_id
     where j.tenant_id = $1 and date_trunc('month', jc.closed_at) = date_trunc('month', now());`,
    [fixtures.tenantAId]
  );
  const jobsClosed = ffrRawRows.rows.length;
  const firstTimeFixes = ffrRawRows.rows.filter((r) => r.first_time_fix === true).length;
  const expectedFfrPct = round1((100 * firstTimeFixes) / jobsClosed);
  note(`direct-db: independently computed current-month first-time-fix-rate: jobs_closed=${jobsClosed}, first_time_fixes=${firstTimeFixes}, ffr_pct=${expectedFfrPct}`);

  await directDb.end();
  ok("direct-db: connection closed cleanly before restarting the server");

  console.log("Restarting API against the same Postgres schema...");
  serverProc = await spawnServer();
  await waitForHealth();
  ok("server restarted and reconnected to the same Postgres schema");

  const hoursVarianceRes = await officeA.get("/dashboard/hours-variance");
  const byJobType = hoursVarianceRes.json?.by_job_type ?? [];
  let hvAllMatch = true;
  for (const [jobType, expected] of expectedHoursVariance) {
    const row = byJobType.find((r) => r.job_type === jobType);
    const matches = row && row.n === expected.n && row.avg_hours_delta === expected.avg_hours_delta && row.avg_pct_variance === expected.avg_pct_variance;
    if (!matches) {
      hvAllMatch = false;
      fail(`dashboard/hours-variance: ${jobType} matches independent computation`, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(row)}`);
    }
  }
  if (hvAllMatch) {
    ok(`dashboard/hours-variance: both job_types' n/avg_hours_delta/avg_pct_variance match the independently-derived raw-SQL values (proves it reads v_hours_variance over the live restarted server, not a cache)`);
  }

  const ffrRes = await officeA.get("/dashboard/first-time-fix-rate?months=1");
  const months = ffrRes.json?.months ?? [];
  const currentMonthRow = months[0];
  if (
    months.length === 1 &&
    currentMonthRow?.jobs_closed === jobsClosed &&
    currentMonthRow?.first_time_fixes === firstTimeFixes &&
    currentMonthRow?.ffr_pct === expectedFfrPct
  ) {
    ok(`dashboard/first-time-fix-rate: jobs_closed=${currentMonthRow.jobs_closed}, first_time_fixes=${currentMonthRow.first_time_fixes}, ffr_pct=${currentMonthRow.ffr_pct} matches the independently-derived raw-SQL values`);
  } else {
    fail("dashboard/first-time-fix-rate: matches independent computation", JSON.stringify({ expected: { jobsClosed, firstTimeFixes, expectedFfrPct }, got: months }));
  }

  await finish();
}

// Deletes the mirrored public.tenant row (see main()'s own comment) and
// every real row this run created under it, in FK-safe order (children
// before the tenant itself -- none of these tables cascade-delete).
// Idempotent/safe to call even if the mirror was never created (an early
// failure before that point) or already cleaned up.
async function cleanupMirroredTenant() {
  if (classicSchemaClient) {
    await classicSchemaClient.end().catch(() => {});
    classicSchemaClient = null;
  }
  if (!publicSchemaClient || !mirroredTenantId) return;
  // Each delete in its own try/catch, matching support-tickets-proof.mjs's
  // own step() cleanup pattern -- a real incident this session's own first
  // version of this function hit: one delete throwing (a cleanup-order bug,
  // since fixed) aborted every delete after it, silently orphaning the
  // tenant row itself in the shared project until caught and hand-cleaned
  // up separately. FK-safe order below: receipt_line/receipt/supplier_price
  // all reference app_user (confirmed_by/created_by), so app_user is
  // deleted AFTER them, not before -- and before tenant, which everything
  // references. supplier_price also FKs to receipt
  // (fk_supplier_price_receipt), so it must go BEFORE receipt, not after.
  async function step(label, sql) {
    try {
      await publicSchemaClient.query(sql, [mirroredTenantId]);
    } catch (err) {
      console.log(`  (cleanup warning: ${label} -> ${err.message})`);
    }
  }
  await step("receipt_line", `delete from receipt_line where tenant_id = $1;`);
  await step("supplier_price", `delete from supplier_price where tenant_id = $1;`);
  await step("receipt", `delete from receipt where tenant_id = $1;`);
  await step("catalog_item", `delete from catalog_item where tenant_id = $1;`);
  await step("supplier", `delete from supplier where tenant_id = $1;`);
  await step("app_user", `delete from app_user where tenant_id = $1;`);
  await step("tenant", `delete from tenant where id = $1;`);
  await publicSchemaClient.end().catch(() => {});
  publicSchemaClient = null;
  mirroredTenantId = null;
}

async function finish() {
  await killServerHard();
  await cleanupMirroredTenant();
  console.log("\n" + (failures === 0
    ? "All Phase 4 exit-criterion checks passed."
    : `${failures} check(s) failed — see FAIL lines above.`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Proof script crashed:", err);
  await killServerHard();
  await cleanupMirroredTenant();
  process.exit(1);
});
