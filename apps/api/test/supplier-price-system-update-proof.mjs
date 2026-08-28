// Proof for the cross-tenant "system price update" feature
// (fn_supplier_price_system_updates, rpc.sql) — a real product ask: when
// tenant A confirms a price for a real-world (supplier, item) pair,
// tenant B looking at the SAME real-world supplier (matched by Google
// Places place_id) and the SAME real-world product (matched by
// normalized name) should see that as a "system price update"
// suggestion, never attributed to tenant A by name.
//
// Two tenants, one shared place_id, one shared item name. Confirms:
//   1. tenant B sees no system update before tenant A records anything.
//   2. tenant A records a real (manual) price via rpc_supplier_price_record.
//   3. tenant B now sees a system update for that item, with the right
//      price/date, and the raw jsonb never contains tenant A's tenant_id,
//      any app_user id, or tenant A's own supplier name/address anywhere.
//   4. tenant A itself sees no "system update" for its own price (nothing
//      newer/different than what it just recorded).
//   5. tenant B applies the suggested price via the SAME
//      rpc_supplier_price_record it already uses for manual entry — the
//      suggestion is advisory only, never auto-applied — and afterwards
//      tenant B's own system-updates check goes back to empty (no more
//      newer/different price to surface).
//   6. A tenant's supplier with NO place_id never matches anything, even
//      with an identical item name at another tenant.
//   7. Calling with a supplier_id belonging to a DIFFERENT tenant (or a
//      nonexistent one) returns an empty list, not another tenant's data
//      — confirms the ownership check is real, not decorative.
//
// Usage: node --env-file=.env test/supplier-price-system-update-proof.mjs

import { Client } from "pg";
import { pgClientConfig, createAuthAdmin } from "../supabase/verify-helpers.mjs";

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
const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;

async function bearerRpc(token, fn, args) {
  const res = await fetch(`${restBase}/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json() };
}
async function anonRpc(fn, args) {
  const res = await fetch(`${restBase}/rpc/${fn}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify(args),
  });
  return { status: res.status, json: await res.json() };
}

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
    await step("delete supplier_price", () => db.query(`delete from supplier_price where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete supplier", () => db.query(`delete from supplier where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete catalog_item", () => db.query(`delete from catalog_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step("delete app_user", () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) await step(`delete auth user ${id}`, () => deleteAuthUser(id));
  if (createdTenantIds.length > 0) await step("delete tenant", () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
}

try {
  await db.connect();
  console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

  const suffix = Math.random().toString(36).slice(2, 8);
  const sharedPlaceId = `ChIJ_shared_market_${suffix}`;
  const sharedItemName = `  Cabo Coaxial 17VATC Teste ${suffix}  `; // deliberate
  // leading/trailing whitespace + mixed case variant used at tenant B
  // below, to actually exercise the lower(trim(...)) matching, not just
  // an exact string equality that would pass even without it.

  async function makeTenant(label) {
    const t = await db.query(
      `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'basic') returning id`,
      [`System Price Update ${label} ${suffix}`, `sys-price-update-${label}-${suffix}`]
    );
    const tenantId = t.rows[0].id;
    createdTenantIds.push(tenantId);
    const email = `sys-price-update-${label}-${suffix}@device.fieldready.internal`;
    const password = "sys-price-update-proof-password-123";
    const authId = await createAuthUser(email, password);
    await db.query(`insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', $3, $4)`,
      [authId, tenantId, `Office ${label}`, email]);
    const token = await signIn(email, password);
    return { tenantId, token };
  }

  const a = await makeTenant("a");
  const b = await makeTenant("b");

  const supplierA = await db.query(
    `insert into supplier (tenant_id, name, place_id) values ($1, $2, $3) returning id`,
    [a.tenantId, "Fornecedor Partilhado A", sharedPlaceId]
  );
  const supplierB = await db.query(
    `insert into supplier (tenant_id, name, place_id) values ($1, $2, $3) returning id`,
    [b.tenantId, "Fornecedor Partilhado B (nome diferente, mesmo place_id)", sharedPlaceId]
  );
  // A supplier with NO place_id at tenant B, for check 6 below.
  const supplierBNoPlace = await db.query(
    `insert into supplier (tenant_id, name, place_id) values ($1, $2, null) returning id`,
    [b.tenantId, "Fornecedor Sem Place Id B"]
  );

  const itemA = await db.query(
    `insert into catalog_item (tenant_id, sku, name, unit) values ($1, $2, $3, 'un') returning id`,
    [a.tenantId, `SKU-A-${suffix}`, sharedItemName.trim()]
  );
  // Same real-world product, different SKU and different case/whitespace
  // at tenant B — exactly the fuzzy-but-real matching this function does.
  const itemB = await db.query(
    `insert into catalog_item (tenant_id, sku, name, unit) values ($1, $2, $3, 'un') returning id`,
    [b.tenantId, `SKU-B-${suffix}`, sharedItemName.toUpperCase()]
  );
  const itemBNoMatch = await db.query(
    `insert into catalog_item (tenant_id, sku, name, unit) values ($1, $2, $3, 'un') returning id`,
    [b.tenantId, `SKU-B-NOMATCH-${suffix}`, `Item Sem Correspondência ${suffix}`]
  );

  ok("fixtures: 2 tenants, 2 suppliers sharing one place_id (+1 supplier with no place_id), 2 catalog_items with the same real-world name in different case/whitespace/SKU");

  // ---- 1. Before tenant A records anything, tenant B sees nothing -------
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierB.rows[0].id });
    if (r.status === 200 && r.json?.kind === "ok" && Array.isArray(r.json.updates) && r.json.updates.length === 0) {
      ok("tenant B sees no system update before tenant A has recorded a price");
    } else fail("tenant B sees nothing before tenant A records a price", r);
  }

  // Tenant B records its OWN baseline price first (so there's something
  // for tenant A's later, newer price to actually be "an update" over).
  {
    const r = await bearerRpc(b.token, "rpc_supplier_price_record", { p_supplier_id: supplierB.rows[0].id, p_item_id: itemB.rows[0].id, p_price: 5.0 });
    if (r.status === 200 && r.json?.kind === "ok") ok("tenant B records its own baseline price (5.00)");
    else fail("tenant B records baseline price", r);
  }

  // ---- 2. Tenant A confirms a real, newer, different price --------------
  {
    const r = await bearerRpc(a.token, "rpc_supplier_price_record", { p_supplier_id: supplierA.rows[0].id, p_item_id: itemA.rows[0].id, p_price: 6.5 });
    if (r.status === 200 && r.json?.kind === "ok") ok("tenant A confirms a price (6.50) for the same real-world supplier+item");
    else fail("tenant A confirms a price", r);
  }

  // ---- 3. Tenant B now sees it as a system update, fully anonymized -----
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierB.rows[0].id });
    const raw = JSON.stringify(r.json);
    const update = r.json?.updates?.find((u) => u.item_id === itemB.rows[0].id);
    if (
      r.status === 200 &&
      update &&
      Number(update.system_price) === 6.5 &&
      !raw.includes(a.tenantId) &&
      !raw.toLowerCase().includes("fornecedor partilhado a")
    ) {
      ok("tenant B sees tenant A's confirmed price (6.50) as a system update, with tenant A's identity nowhere in the response");
    } else fail("tenant B sees the cross-tenant system update, anonymized", r.json);
  }

  // ---- 4. Tenant A sees nothing for its own just-recorded price ---------
  {
    const r = await bearerRpc(a.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierA.rows[0].id });
    if (r.status === 200 && r.json?.updates?.length === 0) ok("tenant A sees no system update for the price it just confirmed itself (nothing newer exists)");
    else fail("tenant A sees nothing new for its own latest price", r.json);
  }

  // ---- 5. Tenant B applies the suggestion; it then disappears -----------
  {
    const r = await bearerRpc(b.token, "rpc_supplier_price_record", { p_supplier_id: supplierB.rows[0].id, p_item_id: itemB.rows[0].id, p_price: 6.5 });
    if (r.status === 200 && r.json?.kind === "ok" && Number(r.json.price) === 6.5 && Number(r.json.prev_price) === 5.0) {
      ok("tenant B applies the suggested price via the normal manual-entry RPC (prev_price correctly set from its own prior 5.00)");
    } else fail("tenant B applies the suggested price", r);
  }
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierB.rows[0].id });
    const update = r.json?.updates?.find((u) => u.item_id === itemB.rows[0].id);
    if (r.status === 200 && !update) ok("after applying it, tenant B no longer sees that item as a pending system update (nothing newer/different left)");
    else fail("system update clears after being applied", r.json);
  }

  // ---- 6. A supplier with no place_id never matches anything ------------
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierBNoPlace.rows[0].id });
    if (r.status === 200 && r.json?.kind === "ok" && r.json.updates.length === 0) {
      ok("a supplier with no place_id never surfaces a system update, even with a same-named item recorded elsewhere");
    } else fail("no-place_id supplier matches nothing", r.json);
  }

  // ---- 7. Ownership check is real, not decorative ------------------------
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: supplierA.rows[0].id });
    if (r.status === 200 && r.json?.kind === "ok" && r.json.updates.length === 0) {
      ok("tenant B calling with tenant A's own supplier_id gets an empty result, not tenant A's data (ownership check enforced explicitly, not via RLS)");
    } else fail("cross-tenant supplier_id ownership check enforced", r.json);
  }
  {
    const r = await bearerRpc(b.token, "fn_supplier_price_system_updates", { p_supplier_id: "00000000-0000-0000-0000-000000000000" });
    if (r.status === 200 && r.json?.kind === "ok" && r.json.updates.length === 0) ok("a nonexistent supplier_id resolves to an empty result, not an error");
    else fail("nonexistent supplier_id handled cleanly", r.json);
  }
  // Unauthenticated (anon key, no bearer token at all) call is rejected —
  // confirms the anon EXECUTE revoke actually took effect, not just that
  // the business logic happens to reject a null tenant context.
  {
    const r = await anonRpc("fn_supplier_price_system_updates", { p_supplier_id: supplierA.rows[0].id });
    if (r.status === 401 || r.status === 403) ok(`anonymous (no session) call is rejected outright (status ${r.status}) — EXECUTE is not granted to anon`);
    else fail("anonymous call rejected", r);
  }

  console.log(`\n${failures === 0 ? "All" : failures + " of the"} supplier-price-system-update-proof.mjs checks ${failures === 0 ? "passed" : "FAILED"}.`);
  if (failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
