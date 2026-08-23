// FieldReady — verifies the four §6 Step 5 RPCs added for the
// suppliers/quotes cutover (rpc_supplier_price_record, rpc_quote_create,
// rpc_quote_lines_replace, rpc_quote_accept — rpc.sql's own comments on
// each explain why they needed one). Exercised through the real HTTP
// surface a browser would use — real Supabase Auth sign-in, real
// supabase.rpc() calls — same rigor as verify-job-complete.mjs /
// verify-step3-read-write.mjs.
//
// Technician device pairing is NOT covered here — see rpc.sql's own
// comment on why that RPC was dropped from this slice entirely (pairing
// means provisioning a real auth.users row via the Admin API, a separate,
// later migration, not a plain RLS-scoped RPC).
//
// Assumes schema.sql and rpc.sql (apply with `npm run apply:rpc-supabase`
// if missing) are already applied.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-suppliers-quotes-technicians.mjs

import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createReporter, pgClientConfig, createAuthAdmin } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.');
  process.exit(1);
}

const supabaseUrl = `https://${projectRef}.supabase.co`;
const authApiBase = `${supabaseUrl}/auth/v1`;

const reporter = createReporter();
const { ok, fail } = reporter;
const db = new Client(pgClientConfig(projectRef, dbPassword));

const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser } = createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds });
const createdTenantIds = [];

function anonClient() {
  return createClient(supabaseUrl, anonKey);
}
async function signInAs(email, password) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  if (!data.session) throw new Error(`sign-in for ${email} returned no session`);
  return client;
}

async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  if (createdTenantIds.length > 0) {
    await step('delete technician_device', () => db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete supplier_price', () => db.query(`delete from supplier_price where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete quote_line', () => db.query(`delete from quote_line where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete quote', () => db.query(`delete from quote where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete supplier', () => db.query(`delete from supplier where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete catalog_item', () => db.query(`delete from catalog_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete app_user', () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id).then((s) => { if (!s) throw new Error('deleteAuthUser returned false'); }));
  }
  if (createdTenantIds.length > 0) {
    await step('delete tenant', () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

try {
  const precheck = await db.query(
    `select to_regprocedure('public.rpc_supplier_price_record(uuid, uuid, numeric)') is not null as p1,
            to_regprocedure('public.rpc_quote_create(uuid, text, numeric, numeric)') is not null as p2,
            to_regprocedure('public.rpc_quote_lines_replace(uuid, jsonb)') is not null as p3,
            to_regprocedure('public.rpc_quote_accept(uuid)') is not null as p4`
  );
  const r = precheck.rows[0];
  if (!r.p1 || !r.p2 || !r.p3 || !r.p4) {
    console.error('\nOne or more new RPCs not found — run `npm run apply:rpc-supabase` first.');
    await db.end();
    process.exit(1);
  }
  ok('all four new RPCs are applied');

  // ---- fixtures: two tenants, one office user each ------------------------
  const suffix = Math.random().toString(36).slice(2, 8);

  const tenantA = await db.query(`insert into tenant (name, slug) values ($1, $2) returning id`, [`SQT Proof A ${suffix}`, `sqt-proof-a-${suffix}`]);
  const tenantAId = tenantA.rows[0].id;
  createdTenantIds.push(tenantAId);
  const tenantB = await db.query(`insert into tenant (name, slug) values ($1, $2) returning id`, [`SQT Proof B ${suffix}`, `sqt-proof-b-${suffix}`]);
  const tenantBId = tenantB.rows[0].id;
  createdTenantIds.push(tenantBId);

  const emailA = `sqt-a-${suffix}@device.fieldready.internal`;
  const emailB = `sqt-b-${suffix}@device.fieldready.internal`;
  const password = 'proof-pass-sqt-verify';
  const authIdA = await createAuthUser(emailA, password);
  const authIdB = await createAuthUser(emailB, password);

  const officeA = await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3) returning id`,
    [authIdA, tenantAId, emailA]
  );
  const officeAAppUserId = officeA.rows[0].id;
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`,
    [authIdB, tenantBId, emailB]
  );

  const clientA = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A') returning id`, [tenantAId]);
  const clientAId = clientA.rows[0].id;

  const catalogItem = await db.query(
    `insert into catalog_item (tenant_id, sku, name, unit) values ($1, 'SKU-1', 'Cabo coaxial', 'un') returning id`,
    [tenantAId]
  );
  const catalogItemId = catalogItem.rows[0].id;

  const supplierA = await db.query(`insert into supplier (tenant_id, name) values ($1, 'Fornecedor A') returning id`, [tenantAId]);
  const supplierAId = supplierA.rows[0].id;

  const officeASession = await signInAs(emailA, password);
  const officeBSession = await signInAs(emailB, password);
  ok('fixtures created: 2 tenants, 2 office users, 1 client, 1 catalog item, 1 supplier');

  // ==== schema.sql's tenant_id default fix (all 22 tenant tables) =========
  // Review finding (confirmed and fixed): tenant_id had no default on any
  // of the 22 tenant-scoped tables, so a plain client-side .insert(...)
  // that omits it (every direct, non-RPC write — every RPC in this file
  // already sets tenant_id explicitly, so this never affected them) sent
  // NULL, and null = fn_current_tenant_id() is UNKNOWN, not true, so RLS's
  // WITH CHECK rejected the row with 42501 before NOT NULL even got a
  // chance to. Confirmed via the exact call shape apps/web's
  // NewClientForm makes (no tenant_id in the insert body at all).
  {
    const { data, error } = await officeASession.from('client').insert({ name: 'Cliente via insert direto' }).select().single();
    if (error) fail('client insert with no explicit tenant_id', error);
    else if (data.tenant_id === tenantAId) {
      ok('client insert with no explicit tenant_id succeeds, tenant_id defaults to the calling session\'s own tenant');
    } else fail('client insert tenant_id default', new Error(JSON.stringify(data)));
  }

  // ==== rpc_supplier_price_record =========================================
  {
    const first = await officeASession.rpc('rpc_supplier_price_record', {
      p_supplier_id: supplierAId, p_item_id: catalogItemId, p_price: 10.0,
    });
    if (first.error) fail('supplier_price: first entry', first.error);
    else if (first.data.kind === 'ok' && first.data.prev_price === null) {
      ok('supplier_price: first entry applies with prev_price=null');
    } else fail('supplier_price: first entry', new Error(JSON.stringify(first.data)));

    const second = await officeASession.rpc('rpc_supplier_price_record', {
      p_supplier_id: supplierAId, p_item_id: catalogItemId, p_price: 12.5,
    });
    if (second.error) fail('supplier_price: second entry', second.error);
    else if (second.data.kind === 'ok' && Number(second.data.prev_price) === 10 && Number(second.data.price) === 12.5) {
      ok('supplier_price: second entry updates in place, prev_price=10.00, price=12.50');
    } else fail('supplier_price: second entry', new Error(JSON.stringify(second.data)));

    const row = await db.query(`select count(*)::int as n from supplier_price where supplier_id = $1 and item_id = $2`, [supplierAId, catalogItemId]);
    if (row.rows[0].n === 1) ok('supplier_price: independently confirmed exactly one row exists (update-in-place, not accumulating)');
    else fail('supplier_price: exactly one row', new Error(`found ${row.rows[0].n} rows`));

    const attrib = await db.query(`select created_by from supplier_price where supplier_id = $1 and item_id = $2`, [supplierAId, catalogItemId]);
    if (attrib.rows[0].created_by === officeAAppUserId) ok('supplier_price: created_by resolves to the calling session\'s own app_user id');
    else fail('supplier_price: created_by attribution', new Error(`expected ${officeAAppUserId}, got ${attrib.rows[0].created_by}`));

    const cross = await officeBSession.rpc('rpc_supplier_price_record', {
      p_supplier_id: supplierAId, p_item_id: catalogItemId, p_price: 99,
    });
    if (cross.error) fail('supplier_price: cross-tenant', cross.error);
    else if (cross.data.kind === 'supplier_not_found') ok('supplier_price: tenant B targeting tenant A\'s supplier gets supplier_not_found (RLS hides it, not a leak)');
    else fail('supplier_price: cross-tenant rejection', new Error(JSON.stringify(cross.data)));
  }

  // ==== rpc_quote_create ===================================================
  let quoteId;
  {
    const { data, error } = await officeASession.rpc('rpc_quote_create', {
      p_client_id: clientAId, p_job_type: 'TDT novo', p_quoted_hours: 3, p_quoted_materials: 150,
    });
    if (error) fail('quote_create: ok', error);
    else if (data.kind === 'ok' && data.id) {
      quoteId = data.id;
      ok('quote_create: succeeds, returns a real id');
    } else fail('quote_create: ok', new Error(JSON.stringify(data)));

    const row = await db.query(`select created_by, status from quote where id = $1`, [quoteId]);
    if (row.rows[0].created_by === officeAAppUserId && row.rows[0].status === 'draft') {
      ok('quote_create: created_by resolves server-side, status defaults to draft');
    } else fail('quote_create: attribution + default status', new Error(JSON.stringify(row.rows[0])));
  }

  // ==== rpc_quote_lines_replace ============================================
  {
    const first = await officeASession.rpc('rpc_quote_lines_replace', {
      p_quote_id: quoteId,
      p_lines: [
        { description: 'Kit A', qty: 2, unit_price: 20 },
        { item_id: catalogItemId, description: 'Cabo', qty: 5, unit_price: 3.5 },
      ],
    });
    if (first.error) fail('quote_lines_replace: first call', first.error);
    else if (first.data.kind === 'ok' && first.data.lines.length === 2) {
      ok('quote_lines_replace: first call inserts 2 lines');
    } else fail('quote_lines_replace: first call', new Error(JSON.stringify(first.data)));

    // Review finding (confirmed and fixed): v_row used to be declared
    // `record` in the SQL, which meant to_jsonb(v_row) wrapped the already-
    // correct {id: ...} value in an extra layer named after the record's
    // one accidentally-named column ({"jsonb_build_object": {id: ...}}).
    // job-detail.tsx never reads data.lines so this was invisible in
    // practice, but a real frontend-shaped call (this one) would have
    // silently gotten the wrong shape if it ever did. Checked directly,
    // not just trusting first.data.lines.length above.
    const firstLineId = first.data?.lines?.[0]?.id;
    if (typeof firstLineId === 'string' && firstLineId.length > 0) {
      ok('quote_lines_replace: each returned line has a real top-level .id (not wrapped under .jsonb_build_object)');
    } else {
      fail('quote_lines_replace: returned line shape', new Error(JSON.stringify(first.data.lines)));
    }

    const replaced = await officeASession.rpc('rpc_quote_lines_replace', {
      p_quote_id: quoteId,
      p_lines: [{ description: 'Kit B (replacement)', qty: 1, unit_price: 99 }],
    });
    if (replaced.error) fail('quote_lines_replace: replacement call', replaced.error);
    else if (replaced.data.kind === 'ok' && replaced.data.lines.length === 1) {
      ok('quote_lines_replace: second call fully replaces (1 line now, not 3)');
    } else fail('quote_lines_replace: replacement call', new Error(JSON.stringify(replaced.data)));

    const rows = await db.query(`select description, qty, unit_price, item_id from quote_line where quote_id = $1`, [quoteId]);
    if (rows.rows.length === 1 && rows.rows[0].description === 'Kit B (replacement)') {
      ok('quote_lines_replace: independently confirmed exactly the replacement line exists in the database');
    } else fail('quote_lines_replace: db confirmation', new Error(JSON.stringify(rows.rows)));

    const notFound = await officeASession.rpc('rpc_quote_lines_replace', {
      p_quote_id: '00000000-0000-0000-0000-000000000000', p_lines: [],
    });
    if (!notFound.error && notFound.data.kind === 'not_found') ok('quote_lines_replace: nonexistent quote id returns not_found');
    else fail('quote_lines_replace: not_found', new Error(JSON.stringify(notFound.data ?? notFound.error)));
  }

  // ==== rpc_quote_accept ====================================================
  {
    const { data, error } = await officeASession.rpc('rpc_quote_accept', { p_quote_id: quoteId });
    if (error) fail('quote_accept: ok', error);
    else if (data.kind === 'ok' && data.status === 'accepted' && data.accepted_at) {
      ok('quote_accept: status flips to accepted, accepted_at stamped');
    } else fail('quote_accept: ok', new Error(JSON.stringify(data)));

    const again = await officeASession.rpc('rpc_quote_accept', { p_quote_id: quoteId });
    if (!again.error && again.data.kind === 'conflict' && again.data.status === 'accepted') {
      ok('quote_accept: re-accepting an already-accepted quote returns conflict, not a silent no-op');
    } else fail('quote_accept: conflict on re-accept', new Error(JSON.stringify(again.data ?? again.error)));

    const cross = await officeBSession.rpc('rpc_quote_accept', { p_quote_id: quoteId });
    if (!cross.error && cross.data.kind === 'not_found') ok('quote_accept: tenant B targeting tenant A\'s quote gets not_found (RLS hides it)');
    else fail('quote_accept: cross-tenant rejection', new Error(JSON.stringify(cross.data ?? cross.error)));
  }

  // Technician device pairing is deliberately NOT covered here — see
  // rpc.sql's own comment on why it was dropped from this slice (pairing
  // means provisioning a real auth.users row via the Admin API, which
  // needs the service_role key, not something a plain RLS-scoped RPC can
  // do). apps/web's /office/technicians page stays entirely Fastify-backed.

  console.log(`\n${reporter.failures === 0 ? 'All' : reporter.failures + ' of the'} verify-suppliers-quotes-technicians.mjs checks ${reporter.failures === 0 ? 'passed' : 'FAILED'}.`);
  if (reporter.failures > 0) process.exitCode = 1;
} finally {
  await cleanupFixtures();
  await db.end();
}
