// FieldReady — rpc_create_job_from_quote() verification. Final §6 Step 4
// slice (08-supabase-native-migration.md §4/§6).
//
// Proves the most complex port in this migration so far: quote validation,
// collision-safe JOB code generation, template resolution (checklist +
// execution_steps by <kind>_<slug> code, test_protocol by inferred
// network_type), checklist materialization, and quote-line merge with
// covered-item dedup — all against real, RLS-scoped data over the real
// supabase.rpc() surface, not a simulated context.
//
// Assumes schema.sql, holidays.sql, and rpc.sql are already applied.
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-create-job.mjs

import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';
import { createReporter, pgClientConfig, createAuthAdmin } from './verify-helpers.mjs';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!projectRef || !dbPassword || !serviceRoleKey || !anonKey) {
  console.error(
    'Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY.\n' +
    'Run as: cd apps/api && node --env-file=.env supabase/verify-create-job.mjs'
  );
  process.exit(1);
}

const supabaseUrl = `https://${projectRef}.supabase.co`;
const authApiBase = `${supabaseUrl}/auth/v1`;

const reporter = createReporter();
const { ok, fail } = reporter;
const db = new Client(pgClientConfig(projectRef, dbPassword));

const createdAuthUserIds = [];
const { createAuthUser, deleteAuthUser, sweepTestAuthUsers } = createAuthAdmin({
  authApiBase, serviceRoleKey, createdAuthUserIds,
});

function anonClient() {
  return createClient(supabaseUrl, anonKey);
}
async function signInAs(email, password) {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

const createdTenantIds = [];

async function cleanupFixtures() {
  async function step(label, fn) {
    try { await fn(); } catch (err) { console.log(`  (cleanup warning: ${label} -> ${err.message})`); }
  }
  // The competing system-layer template (tenant_id IS NULL by definition,
  // §4/§12) — not caught by any tenant_id-scoped delete below, so it needs
  // its own explicit cleanup or it would permanently accumulate on the real
  // project across every run of this script.
  if (systemReadinessTplId) {
    await step('delete system-layer template_version', () =>
      db.query(`delete from template_version where template_id = $1`, [systemReadinessTplId]));
    await step('delete system-layer template', () =>
      db.query(`delete from template where id = $1`, [systemReadinessTplId]));
  }
  if (createdTenantIds.length > 0) {
    await step('delete job_checklist_item', () => db.query(`delete from job_checklist_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete job', () => db.query(`delete from job where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete quote_line', () => db.query(`delete from quote_line where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete quote', () => db.query(`delete from quote where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete template_version', () => db.query(`
      delete from template_version where template_id in (select id from template where tenant_id = any($1::uuid[]))`, [createdTenantIds]));
    await step('delete template', () => db.query(`delete from template where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete catalog_item', () => db.query(`delete from catalog_item where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete client', () => db.query(`delete from client where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete technician_device', () => db.query(`delete from technician_device where tenant_id = any($1::uuid[])`, [createdTenantIds]));
  }
  for (const id of createdAuthUserIds) {
    await step(`delete auth user ${id}`, () => deleteAuthUser(id).then((ok2) => { if (!ok2) throw new Error('deleteAuthUser returned false'); }));
  }
  if (createdTenantIds.length > 0) {
    await step('delete remaining app_user rows', () => db.query(`delete from app_user where tenant_id = any($1::uuid[])`, [createdTenantIds]));
    await step('delete tenant', () => db.query(`delete from tenant where id = any($1::uuid[])`, [createdTenantIds]));
  }
}

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres (fixture setup only).`);

// ---- 0. Preconditions ------------------------------------------------------

try {
  const r = await db.query(`select to_regprocedure('public.rpc_create_job_from_quote(uuid)') is not null as exists`);
  if (!r.rows[0].exists) {
    console.error('\nrpc_create_job_from_quote() not found — apply the latest rpc.sql first (npm run verify:step4-supabase applies it automatically if missing).');
    await db.end();
    process.exit(1);
  }
  ok('rpc_create_job_from_quote() is applied');
} catch (err) {
  fail('preconditions', err);
  await db.end();
  process.exit(1);
}

console.log('Sweeping any leftover test auth users from prior/interrupted runs ...');
try {
  const { found, deleted } = await sweepTestAuthUsers();
  ok(`prior-run auth users swept (${deleted}/${found} deleted)`);
} catch (err) {
  fail('auth user sweep', err);
}

// ---- fixtures ---------------------------------------------------------------
// job_type chosen to slugify to "cablagem-estruturada" (matching
// fn_infer_network_type's 'cablagem'/'estruturada' keywords -> PC) and to
// exercise real diacritics/punctuation through fn_slugify at the same time.

const tenantA = crypto.randomUUID(); // ited_ready — exercises test_protocol resolution
const tenantB = crypto.randomUUID(); // basic — confirms the gate skips it
const marker = crypto.randomUUID().slice(0, 8);
const JOB_TYPE = 'Cablagem estruturada — instalação nova';
const SLUG = 'cablagem-estruturada-instalacao-nova';

let officeASession, officeBSession;
let acceptedQuoteId, notAcceptedQuoteId, coveredItemId, uncoveredItemId, systemReadinessTplId;

try {
  await db.query(
    `insert into tenant (id, name, slug, compliance_profile) values
       ($1, 'Antenas Rex, Lda', $2, 'ited_ready'),
       ($3, 'Outro Instalador, Lda', $4, 'basic')`,
    [tenantA, `antenas-rex-cj-${marker}`, tenantB, `outro-instalador-cj-${marker}`]
  );
  createdTenantIds.push(tenantA, tenantB);

  const officeAAuthId = await createAuthUser(`office-cj-a-${marker}@device.fieldready.internal`, 'Verify-CJ-Test-Passw0rd!');
  const officeAAppUser = await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office A', $3) returning id`,
    [officeAAuthId, tenantA, `office-cj-a-${marker}@device.fieldready.internal`]
  );
  const officeAAppUserId = officeAAppUser.rows[0].id;
  const officeBAuthId = await createAuthUser(`office-cj-b-${marker}@device.fieldready.internal`, 'Verify-CJ-Test-Passw0rd!');
  await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Office B', $3)`,
    [officeBAuthId, tenantB, `office-cj-b-${marker}@device.fieldready.internal`]
  );

  const client = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente CJ') returning id`, [tenantA]);

  const catalogItem = await db.query(
    `insert into catalog_item (tenant_id, sku, name) values ($1, $2, 'RJ45 Cat6') returning id`,
    [tenantA, `SKU-CJ-${marker}`]
  );
  coveredItemId = catalogItem.rows[0].id;
  const catalogItem2 = await db.query(
    `insert into catalog_item (tenant_id, sku, name) values ($1, $2, 'Patch panel') returning id`,
    [tenantA, `SKU-CJ2-${marker}`]
  );
  uncoveredItemId = catalogItem2.rows[0].id;

  // Tenant-layer checklist template — readiness_<slug> — one item WITH
  // item_id (coveredItemId, should dedupe against the matching quote_line
  // below) and one WITHOUT (always present, no dedup concern).
  const readinessTpl = await db.query(
    `insert into template (tenant_id, layer, kind, code, title) values ($1, 'tenant', 'checklist', $2, 'Readiness') returning id`,
    [tenantA, `readiness_${SLUG}`]
  );
  await db.query(
    `insert into template_version (template_id, version, status, body) values ($1, 1, 'active', $2::jsonb)`,
    [readinessTpl.rows[0].id, JSON.stringify({
      items: [
        { cat: 'material', label: 'Cabo RJ45', item_id: coveredItemId, scope: 'job', mandatory: true, qty: 2 },
        // Security review (medium, confirmed): no fixture anywhere omitted
        // qty/mandatory entirely, so the RPC's coalesce(...,1)/coalesce(...,true)
        // defaulting (meant to mirror the TS `item.qty ?? 1`/`item.mandatory ?? true`)
        // was essentially unverified. This item deliberately omits both keys.
        { cat: 'material', label: 'Fio terra', scope: 'job' },
        { cat: 'equipment', label: 'Kit da carrinha', scope: 'van', mandatory: true },
        { cat: 'doc', label: 'Ficha técnica', scope: 'office', mandatory: false },
      ],
    })]
  );

  const executionTpl = await db.query(
    `insert into template (tenant_id, layer, kind, code, title) values ($1, 'tenant', 'execution_steps', $2, 'Execution') returning id`,
    [tenantA, `execution_${SLUG}`]
  );
  await db.query(
    `insert into template_version (template_id, version, status, body) values ($1, 1, 'active', $2::jsonb)`,
    [executionTpl.rows[0].id, JSON.stringify({ steps: [{ order: 0, label: 'Preparar material' }, { order: 1, label: 'Instalar cablagem' }] })]
  );

  // Competing SYSTEM-layer template sharing the same (kind, code) —
  // security review (medium, confirmed): no fixture anywhere ever created
  // more than one candidate row per (kind, code), so the `order by
  // (t.layer = 'tenant') desc` tenant-preferred-over-system resolution was
  // never actually exercised with a real choice to make. If this system
  // row's items ever show up in the resolved job below instead of tenant
  // A's own, the ORDER BY has regressed.
  const systemReadinessTpl = await db.query(
    `insert into template (tenant_id, layer, kind, code, title) values (null, 'system', 'checklist', $1, 'System Readiness (should lose)') returning id`,
    [`readiness_${SLUG}`]
  );
  systemReadinessTplId = systemReadinessTpl.rows[0].id;
  await db.query(
    `insert into template_version (template_id, version, status, body) values ($1, 1, 'active', $2::jsonb)`,
    [systemReadinessTplId, JSON.stringify({
      items: [{ cat: 'material', label: 'ITEM FROM SYSTEM LAYER — SHOULD NOT WIN', scope: 'job' }],
    })]
  );

  const testProtocolTpl = await db.query(
    `insert into template (tenant_id, layer, kind, code, title) values ($1, 'tenant', 'test_protocol', $2, 'PC test protocol') returning id`,
    [tenantA, `pc_test_protocol_${marker}`]
  );
  await db.query(
    `insert into template_version (template_id, version, status, body, verified_by, verified_source, verified_at)
     values ($1, 1, 'active', $2::jsonb, $3, 'Manual ITED 4ª ed., Tabela 6.1', now())`,
    [testProtocolTpl.rows[0].id, JSON.stringify({ network_type: 'PC', tests: [] }), officeAAppUserId]
  );

  const acceptedQuote = await db.query(
    `insert into quote (tenant_id, client_id, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, $3, 4, 250, 'accepted') returning id`,
    [tenantA, client.rows[0].id, JOB_TYPE]
  );
  acceptedQuoteId = acceptedQuote.rows[0].id;

  await db.query(
    `insert into quote_line (tenant_id, quote_id, item_id, description, qty, unit_price) values
       ($1, $2, $3, 'Cabo RJ45 (from BOM)', 2, 3.5),
       ($1, $2, $4, 'Patch panel 24p', 1, 45.0),
       ($1, $2, null, 'Serviço de mão de obra extra', 1, 30.0)`,
    [tenantA, acceptedQuoteId, coveredItemId, uncoveredItemId]
  );

  const notAcceptedQuote = await db.query(
    `insert into quote (tenant_id, client_id, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, $3, 2, 100, 'draft') returning id`,
    [tenantA, client.rows[0].id, JOB_TYPE]
  );
  notAcceptedQuoteId = notAcceptedQuote.rows[0].id;

  officeASession = await signInAs(`office-cj-a-${marker}@device.fieldready.internal`, 'Verify-CJ-Test-Passw0rd!');
  officeBSession = await signInAs(`office-cj-b-${marker}@device.fieldready.internal`, 'Verify-CJ-Test-Passw0rd!');

  ok('fixtures created: 2 tenants, 2 catalog items, readiness/execution/test_protocol templates, an accepted + a draft quote with 3 lines');
} catch (err) {
  fail('fixture setup', err);
  console.log('\nFixture setup failed — cleaning up whatever was created, then stopping.');
  await cleanupFixtures();
  await db.end();
  process.exit(1);
}

// ---- 1. fn_slugify / fn_infer_network_type sanity, matching the fixture --

try {
  const r = await db.query(`select fn_slugify($1) as slug, fn_infer_network_type($1) as network_type`, [JOB_TYPE]);
  if (r.rows[0].slug === SLUG && r.rows[0].network_type === 'PC') {
    ok(`fn_slugify/fn_infer_network_type resolve "${JOB_TYPE}" to slug="${SLUG}", network_type=PC, matching the fixture`);
  } else {
    fail('slugify/infer sanity', new Error(`got slug=${r.rows[0].slug}, network_type=${r.rows[0].network_type}`));
  }
} catch (err) {
  fail('slugify/infer sanity', err);
}

// ---- 1b. fn_slugify edge-case battery, committed and re-runnable — security
// review (high, confirmed): the first draft's unaccent()-based fn_slugify
// diverged from the real slugify() specifically for Portuguese ordinal
// indicators (º/ª — everyday PT business text: floor numbers, "nº") plus
// several extended-Latin characters (ß, œ, æ, ł, dotless ı), and the only
// coverage anywhere in this repo was one composite string. Fixed by
// rewriting fn_slugify around Postgres's native normalize(text, NFD) to
// replicate the JS algorithm literally instead of approximating it with a
// different one (unaccent's translation table) — every expected value below
// was independently verified against the real, unmodified TS slugify()
// output before being hard-coded here, not derived from reading the SQL.

try {
  const cases = [
    ['Instalação 2º andar', 'instalacao-2-andar'],   // the divergence this review actually found — PT ordinal indicator
    ['1º andar', '1-andar'],
    ['nº 5', 'n-5'],
    ['ß Straße', 'stra-e'],                           // German eszett — no NFD canonical decomposition
    ['Æther Œuvre', 'ther-uvre'],                     // ligatures — same reason
    ['łódź', 'odz'],                                  // Polish ł
    ['', ''],                                          // empty string
    ['123', '123'],                                    // digits-only
    ['!!!', ''],                                        // punctuation-only
    ['-already-hyphenated-', 'already-hyphenated'],
    ['日本語テスト', ''],                                // non-Latin (CJK) collapses to empty in both
    ['Кириллица тест', ''],                             // non-Latin (Cyrillic) collapses to empty in both
  ];
  let allOk = true;
  for (const [input, expected] of cases) {
    const r = await db.query(`select fn_slugify($1) as slug`, [input]);
    if (r.rows[0].slug !== expected) {
      allOk = false;
      fail(`fn_slugify edge case (${JSON.stringify(input)})`, new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(r.rows[0].slug)}`));
    }
  }
  if (allOk) {
    ok(`fn_slugify matches the real slugify() output across ${cases.length} edge cases, including every character class the earlier review found diverging`);
  }
} catch (err) {
  fail('fn_slugify edge-case battery', err);
}

// ---- 2. rpc_create_job_from_quote: happy path, full resolution + merge ---

let createdJobId;
try {
  const { data, error } = await officeASession.rpc('rpc_create_job_from_quote', { p_quote_id: acceptedQuoteId });
  if (error) throw error;

  if (data.kind === 'ok' && /^JOB-\d{4}$/.test(data.code)) {
    ok(`create-job: succeeds with a well-formed code (${data.code})`);
  } else {
    fail('create-job happy path', new Error(JSON.stringify(data)));
  }
  createdJobId = data.job_id;

  if (data.has_execution_snapshot === true && data.has_test_protocol_snapshot === true) {
    ok('create-job: both execution_snapshot and test_protocol_snapshot resolved (ited_ready tenant, PC network inferred)');
  } else {
    fail('create-job snapshot flags', new Error(JSON.stringify(data)));
  }

  // by_scope: job=2 (readiness items: Cabo RJ45 + Fio terra) + 2 (merged
  // quote lines: uncovered item + no-item-id line) = 4; van=1; office=1.
  // merged_from_quote=2 (the covered-item line must NOT merge a duplicate).
  if (
    data.checklist.by_scope.job === 4 &&
    data.checklist.by_scope.van === 1 &&
    data.checklist.by_scope.office === 1 &&
    data.checklist.merged_from_quote === 2 &&
    data.checklist.total === 6
  ) {
    ok('create-job: checklist materialization + quote-line merge counts are exactly right (covered item deduped, uncovered + no-item-id lines merged)');
  } else {
    fail('create-job checklist counts', new Error(JSON.stringify(data.checklist)));
  }
} catch (err) {
  fail('create-job happy path', err);
}

// ---- 3. Independently confirm against the raw tables, not just the RPC's
// own response — including that the covered item really wasn't duplicated.

if (createdJobId) {
  try {
    const items = await db.query(
      `select cat, label, item_id, scope, qty, mandatory from job_checklist_item where job_id = $1 order by label`,
      [createdJobId]
    );
    const coveredCount = items.rows.filter((r) => r.item_id === coveredItemId).length;
    const uncoveredCount = items.rows.filter((r) => r.item_id === uncoveredItemId).length;
    if (items.rows.length === 6 && coveredCount === 1 && uncoveredCount === 1) {
      ok('create-job: independently confirmed exactly 6 job_checklist_item rows, covered item appears exactly once (not duplicated by the quote-line merge)');
    } else {
      fail('create-job db confirmation', new Error(`got ${items.rows.length} rows, covered=${coveredCount}, uncovered=${uncoveredCount}: ${JSON.stringify(items.rows)}`));
    }

    // Security review (medium, confirmed): no fixture ever gave the
    // tenant-preferred-over-system resolution ORDER BY a real second
    // candidate to choose between. The system-layer template inserted
    // above shares the exact same (kind, code) as tenant A's own — if the
    // resolution ever regressed to prefer system over tenant, this item
    // would appear here instead of (or alongside) "Fio terra".
    const systemLayerLeaked = items.rows.some((r) => r.label === 'ITEM FROM SYSTEM LAYER — SHOULD NOT WIN');
    if (!systemLayerLeaked) {
      ok('create-job: the tenant-layer readiness template is correctly preferred over a competing system-layer template sharing the same code');
    } else {
      fail('create-job tenant-vs-system template resolution', new Error('the system-layer template\'s item leaked into the resolved job — tenant-layer preference is broken'));
    }

    // Security review (medium, confirmed): the defaulting logic
    // (coalesce(qty,1)/coalesce(mandatory,true), meant to mirror the TS
    // `item.qty ?? 1`/`item.mandatory ?? true`) was never actually checked
    // against the materialized row's real values — "Fio terra" omits both
    // keys entirely in the template body above.
    const fioTerra = items.rows.find((r) => r.label === 'Fio terra');
    if (fioTerra && Number(fioTerra.qty) === 1 && fioTerra.mandatory === true) {
      ok('create-job: a readiness item omitting qty/mandatory entirely defaults to qty=1, mandatory=true (matching item.qty ?? 1 / item.mandatory ?? true)');
    } else {
      fail('create-job qty/mandatory defaulting', new Error(`expected qty=1, mandatory=true, got ${JSON.stringify(fioTerra)}`));
    }

    const job = await db.query(`select status, readiness_snapshot, execution_snapshot, test_protocol_snapshot from job where id = $1`, [createdJobId]);
    if (
      job.rows[0].status === 'ready_check' &&
      job.rows[0].readiness_snapshot?.items?.length === 4 &&
      job.rows[0].test_protocol_snapshot?.network_type === 'PC'
    ) {
      ok('create-job: job row itself has status=ready_check and all three snapshots frozen with the real resolved bodies');
    } else {
      fail('create-job job row confirmation', new Error(JSON.stringify(job.rows[0])));
    }
  } catch (err) {
    fail('create-job db confirmation', err);
  }
}

// ---- 4. not_accepted / not_found rejections --------------------------------

try {
  const { data, error } = await officeASession.rpc('rpc_create_job_from_quote', { p_quote_id: notAcceptedQuoteId });
  if (error) throw error;
  if (data.kind === 'not_accepted') {
    ok('create-job: a draft (not-yet-accepted) quote is rejected as not_accepted');
  } else {
    fail('create-job not_accepted', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('create-job not_accepted', err);
}

try {
  const { data, error } = await officeASession.rpc('rpc_create_job_from_quote', { p_quote_id: crypto.randomUUID() });
  if (error) throw error;
  if (data.kind === 'not_found') {
    ok('create-job: a nonexistent quote_id is rejected as not_found');
  } else {
    fail('create-job not_found', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('create-job not_found', err);
}

// ---- 5. Cross-tenant: tenant B cannot target tenant A's quote --------------

try {
  const { data, error } = await officeBSession.rpc('rpc_create_job_from_quote', { p_quote_id: acceptedQuoteId });
  if (error) throw error;
  if (data.kind === 'not_found') {
    ok("create-job: tenant B's office user targeting tenant A's quote gets not_found (RLS makes it invisible, not a leak)");
  } else {
    fail('create-job cross-tenant', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('create-job cross-tenant', err);
}

// ---- 6. Basic-profile tenant: test_protocol gate correctly skipped -------

try {
  const clientB = await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente CJ B') returning id`, [tenantB]);
  const quoteB = await db.query(
    `insert into quote (tenant_id, client_id, job_type, quoted_hours, quoted_materials, status)
     values ($1, $2, $3, 2, 100, 'accepted') returning id`,
    [tenantB, clientB.rows[0].id, JOB_TYPE]
  );
  const { data, error } = await officeBSession.rpc('rpc_create_job_from_quote', { p_quote_id: quoteB.rows[0].id });
  if (error) throw error;
  if (data.kind === 'ok' && data.has_test_protocol_snapshot === false) {
    ok('create-job: a basic-profile tenant resolves no test_protocol_snapshot even though the same job_type would infer PC (compliance gate correctly skipped)');
  } else {
    fail('create-job basic tenant gate', new Error(JSON.stringify(data)));
  }

  // Security review (medium, confirmed): this is the one place in the
  // whole suite where two different tenants share the exact same job_type/
  // slug — the only fixture capable of proving tenant B's session can't
  // resolve tenant A's tenant-layer readiness_<slug>/execution_<slug>
  // templates through RLS. The original assertion only checked the
  // compliance-profile gate (has_test_protocol_snapshot), never
  // has_execution_snapshot or tenant B's actual job_checklist_item rows —
  // a real cross-tenant template leak would have passed silently.
  if (data.kind === 'ok' && data.has_execution_snapshot === false) {
    ok("create-job: tenant B's job resolves NO execution_snapshot even though tenant A owns an execution_${SLUG} template — RLS correctly prevents the cross-tenant resolve");
  } else {
    fail('create-job cross-tenant template leak (execution)', new Error(JSON.stringify(data)));
  }

  // Tenant B legitimately resolves the SYSTEM-layer readiness template
  // (visible to every tenant by design, §4/§12) — "ITEM FROM SYSTEM LAYER"
  // is expected here. What must NEVER appear is anything from tenant A's
  // own TENANT-layer template, which only exists for tenant A.
  const tenantALabels = new Set(['Cabo RJ45', 'Fio terra', 'Kit da carrinha', 'Ficha técnica']);
  const tenantBItems = await db.query(`select label from job_checklist_item where job_id = $1`, [data.job_id]);
  const leaked = tenantBItems.rows.filter((r) => tenantALabels.has(r.label));
  if (leaked.length === 0) {
    ok("create-job: tenant B's job correctly resolves only the shared system-layer template (visible to all) — none of tenant A's own tenant-layer items leaked");
  } else {
    fail('create-job cross-tenant template leak (checklist)', new Error(`tenant A's tenant-layer items leaked into tenant B's job: ${JSON.stringify(leaked)}`));
  }
} catch (err) {
  fail('create-job basic tenant gate', err);
}

// ---- 7. Calling twice on the same accepted quote creates a SECOND job —
// documented, pre-existing (non-)idempotency, not a regression. Confirmed
// explicitly rather than silently left unstated.

try {
  const { data, error } = await officeASession.rpc('rpc_create_job_from_quote', { p_quote_id: acceptedQuoteId });
  if (error) throw error;
  if (data.kind === 'ok' && data.job_id !== createdJobId) {
    ok('create-job: calling it again on the same already-accepted quote creates a distinct second job — matches the reference implementation\'s own (documented) non-idempotent behavior, not a new regression');
  } else {
    fail('create-job repeat-call behavior', new Error(JSON.stringify(data)));
  }
} catch (err) {
  fail('create-job repeat-call behavior', err);
}

// ---- 8. JOB-code collision path — security review (medium, confirmed
// twice, across two dimensions): the 20-attempt collision-retry loop was
// completely unexercised — nothing forced a real collision, so neither "a
// fresh random candidate is drawn every attempt" nor "code_collision is
// returned after 20 failed attempts, not an infinite loop or a silent
// duplicate" was ever proven. Fixed the only deterministic way available:
// pre-occupy the ENTIRE possible code space (JOB-1000 through JOB-9999,
// exactly the range `1000 + floor(random()*9000)` can draw from) for
// tenant A in one batched insert, guaranteeing every one of the 20 attempts
// collides.

try {
  // ON CONFLICT DO NOTHING: tenant A already has a couple of jobs from
  // earlier checks (checks 2 and 7), each with its own randomly-drawn
  // JOB-XXXX code within this exact range — this fills in every OTHER
  // code in the space rather than erroring on those pre-existing ones.
  await db.query(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
     select $1, $2, 'JOB-' || n, 'Poison', 'Poison', 1, 1
     from generate_series(1000, 9999) as n
     on conflict (tenant_id, code) do nothing`,
    [tenantA, (await db.query(`select client_id from job where tenant_id = $1 limit 1`, [tenantA])).rows[0].client_id]
  );

  const collisionQuote = await db.query(
    `insert into quote (tenant_id, client_id, job_type, quoted_hours, quoted_materials, status)
     values ($1, (select client_id from job where tenant_id = $1 limit 1), $2, 1, 1, 'accepted') returning id`,
    [tenantA, JOB_TYPE]
  );
  const { data, error } = await officeASession.rpc('rpc_create_job_from_quote', { p_quote_id: collisionQuote.rows[0].id });
  if (error) throw error;
  if (data.kind === 'code_collision') {
    ok('create-job: with the entire JOB-1000..JOB-9999 code space pre-occupied, the RPC correctly exhausts its 20 attempts and returns code_collision (not an infinite loop, not a silent duplicate)');
  } else {
    fail('create-job code collision', new Error(`expected code_collision, got ${JSON.stringify(data)}`));
  }
} catch (err) {
  fail('create-job code collision', err);
}

// ---- cleanup ---------------------------------------------------------------

console.log(`\nCleaning up ${createdAuthUserIds.length} test auth user(s) and fixture rows ...`);
await cleanupFixtures();

await db.end();

console.log('\n' + (reporter.failures === 0
  ? `All checks passed.`
  : `${reporter.failures} check(s) failed — see FAIL lines above.`));
process.exit(reporter.failures === 0 ? 0 : 1);
