// FieldReady — Supabase-native schema verification harness.
// 08-supabase-native-migration.md §6 Step 1. Same discipline as
// ../../verify-schema.mjs, extended for the two checks that don't exist
// there at all because the current design doesn't need them (§3):
// unauthenticated-request fail-safe now means "no auth.uid()", and a
// revoked-device-with-a-still-valid-token check that has no equivalent
// under the current SET LOCAL app.current_tenant_id design.
//
// Runs against the REAL Supabase Postgres project (direct connection,
// superuser role) — not PGlite. Resets and re-applies this folder's
// schema.sql on every run so it's safe to re-run; only touches the objects
// schema.sql itself creates, never `drop schema public cascade` (that would
// risk taking out Supabase's own extension objects living in public).
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/verify-schema-supabase.mjs

import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!projectRef || !dbPassword || !serviceRoleKey) {
  console.error(
    'Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY.\n' +
    'Run as: cd apps/api && node --env-file=.env supabase/verify-schema-supabase.mjs'
  );
  process.exit(1);
}

const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;
const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
const schemaSql = readFileSync(schemaPath, 'utf8');

let failures = 0;
function ok(label) { console.log(`  OK   ${label}`); }
function fail(label, err) { failures++; console.log(`  FAIL ${label} -> ${err.message ?? err}`); }

const db = new Client({
  host: `db.${projectRef}.supabase.co`,
  port: 5432,
  user: 'postgres',
  password: dbPassword,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

// ---- auth admin helpers (real Supabase Auth users, cleaned up at the end) -

const createdAuthUserIds = [];

async function createAuthUser(email, password) {
  const res = await fetch(`${authApiBase}/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`createAuthUser(${email}) failed: ${res.status} ${JSON.stringify(body)}`);
  createdAuthUserIds.push(body.id);
  return body.id;
}

async function deleteAuthUser(id) {
  const res = await fetch(`${authApiBase}/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  return res.ok;
}

// Sweep every auth.users row this harness could have created, by the fixed
// email suffix all of them share — not just this run's own createdAuthUserIds
// — so stragglers from an interrupted/failed prior run don't accumulate on
// the real project forever. MUST run after the SQL reset below drops
// technician_device (which FKs auth_user_id with no ON DELETE action, by
// design — see schema.sql's comment on that table) or every delete 500s on
// "still referenced from table technician_device", exactly as it did the
// first time this script's cleanup ran.
async function sweepTestAuthUsers() {
  const res = await fetch(`${authApiBase}/admin/users?per_page=1000`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const body = await res.json();
  const testUsers = (body.users ?? []).filter((u) => u.email?.endsWith('@device.fieldready.internal'));
  let deleted = 0;
  for (const u of testUsers) {
    if (await deleteAuthUser(u.id)) deleted++;
  }
  return { found: testUsers.length, deleted };
}

// ---- simulate PostgREST's request context inside a real transaction ------
// This is Supabase's own documented pattern for exercising RLS from a direct
// SQL connection: `set local role`, then the JWT claims PostgREST would have
// set, as local (transaction-scoped) GUCs. auth.uid() reads either
// request.jwt.claim.sub or request.jwt.claims->>'sub' depending on Supabase
// project version — both are set below so this doesn't depend on which.

async function asUser(authUserId, fn) {
  await db.query('begin');
  try {
    await db.query(`set local role authenticated`);
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: authUserId, role: 'authenticated' }),
    ]);
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [authUserId]);
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

async function asAnon(fn) {
  await db.query('begin');
  try {
    await db.query(`set local role anon`);
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query(`select set_config('request.jwt.claim.sub', '', true)`);
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

async function asSuperuser(fn) {
  await db.query('begin');
  try {
    const result = await fn();
    await db.query('commit');
    return result;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

// ---- run ------------------------------------------------------------------

await db.connect();
console.log(`Connected to db.${projectRef}.supabase.co as postgres.`);

try {
  // Idempotent reset: drop exactly what schema.sql creates, nothing else —
  // never `drop schema public cascade` (would risk Supabase's own objects).
  console.log('Resetting prior run\'s objects (if any) ...');
  await db.query(`
    drop view if exists v_readiness_correlation, v_price_alerts, v_hours_variance,
      v_first_time_fix_rate, v_job_readiness cascade;
    drop table if exists
      job_execution_step_completion, applied_mutation, job_photo, follow_up_action,
      job_closeout, compliance_deadline, termo_responsabilidade, ref_document,
      job_test_result, equipment, van_audit, job_checklist_item, job, quote_line,
      quote, client, receipt_line, receipt, supplier_price, supplier, catalog_item,
      template_version, template, technician_device, app_user, tenant
      cascade;
    drop function if exists fn_current_tenant_id() cascade;
    drop function if exists fn_activate_template_version_guard() cascade;
    drop function if exists fn_ref_termo_reconciliation() cascade;
    drop function if exists fn_termo_ref_reconciliation() cascade;
  `);
  ok('prior run\'s objects reset');
} catch (err) {
  fail('reset', err);
  console.log('\nReset failed — stopping, apply/behavioural checks skipped.');
  await db.end();
  process.exit(1);
}

console.log('Sweeping any leftover test auth users from prior runs ...');
try {
  const { found, deleted } = await sweepTestAuthUsers();
  ok(`prior-run auth users swept (${deleted}/${found} deleted)`);
} catch (err) {
  fail('auth user sweep', err);
}

console.log(`Applying ${schemaPath} ...`);
try {
  await db.query(schemaSql);
  ok('schema applied with no errors');
} catch (err) {
  fail('schema apply', err);
  console.log('\nSchema failed to apply — stopping, behavioural checks skipped.');
  await db.end();
  process.exit(1);
}

// ---- 0. Precondition: fn_current_tenant_id can actually read app_user /
// technician_device despite FORCE ROW LEVEL SECURITY on 20 sibling tables --
// (the "no force row level security" carve-out this file's schema.sql adds
// for exactly these two tables). If this fails, every other RLS check below
// is meaningless — a chicken-and-egg identity failure, not a real isolation
// bug — so it's checked first and explicitly, not inferred from the rest.

let tenantA, tenantB, officeAId, techAId, revokedTechAId;
let officeAAuthId, techAAuthId, revokedTechAAuthId, officeBAuthId;

try {
  tenantA = crypto.randomUUID();
  tenantB = crypto.randomUUID();

  await asSuperuser(async () => {
    await db.query(
      `insert into tenant (id, name, slug) values ($1, 'Antenas Rex, Lda', 'antenas-rex-sb'), ($2, 'Outro Instalador, Lda', 'outro-instalador-sb')`,
      [tenantA, tenantB]
    );
  });

  officeAAuthId = await createAuthUser(
    `office-a-${tenantA}@device.fieldready.internal`,
    'Verify-Schema-Test-Passw0rd!'
  );
  officeAId = crypto.randomUUID();
  await asSuperuser(async () => {
    await db.query(
      `insert into app_user (id, auth_user_id, tenant_id, role, full_name, email) values ($1, $2, $3, 'owner', 'Rex (office A)', 'office-a@test')`,
      [officeAId, officeAAuthId, tenantA]
    );
  });

  const resolved = await asUser(officeAAuthId, async () => {
    const r = await db.query(`select fn_current_tenant_id() as tid`);
    return r.rows[0].tid;
  });

  if (resolved === tenantA) {
    ok('fn_current_tenant_id() resolves office identity through the FORCE-RLS carve-out');
  } else {
    fail('fn_current_tenant_id() precondition', new Error(`expected ${tenantA}, got ${resolved}`));
  }
} catch (err) {
  fail('fn_current_tenant_id() precondition', err);
  console.log('\nIdentity resolution is broken — every check below would be testing nothing. Stopping.');
  for (const id of createdAuthUserIds) await deleteAuthUser(id);
  await db.end();
  process.exit(1);
}

// ---- 1. RLS actually isolates tenants (office identity) --------------------

try {
  officeBAuthId = await createAuthUser(
    `office-b-${tenantB}@device.fieldready.internal`,
    'Verify-Schema-Test-Passw0rd!'
  );
  await asSuperuser(async () => {
    await db.query(
      `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'Someone (office B)', 'office-b@test')`,
      [officeBAuthId, tenantB]
    );
    await db.query(`insert into client (tenant_id, name) values ($1, 'Cliente A')`, [tenantA]);
  });

  const seenAsB = await asUser(officeBAuthId, () => db.query(`select count(*)::int as n from client`));
  const seenAsA = await asUser(officeAAuthId, () => db.query(`select count(*)::int as n from client`));

  if (seenAsB.rows[0].n === 0 && seenAsA.rows[0].n === 1) {
    ok("RLS: tenant B's office user sees 0 of tenant A's clients, tenant A sees its own 1");
  } else {
    fail('RLS tenant isolation', new Error(
      `expected [B:0, A:1], got [B:${seenAsB.rows[0].n}, A:${seenAsA.rows[0].n}]`));
  }
} catch (err) {
  fail('RLS tenant isolation', err);
}

// ---- 2. No auth.uid() at all (anon/unauthenticated) fails safe: zero rows,
// not an error, not all rows. This is the Supabase-native equivalent of
// verify-schema.mjs's "no app.current_tenant_id set" check — same intent
// (fn_current_tenant_id() returns null, every policy evaluates to false),
// different mechanism entirely, so it's rewritten, not carried over. -------

try {
  const r = await asAnon(() => db.query(`select count(*)::int as n from client`));
  if (r.rows[0].n === 0) ok('RLS: no auth.uid() (anon request) => zero rows (fail-safe)');
  else fail('RLS fail-safe (anon)', new Error(`expected 0 rows unauthenticated, got ${r.rows[0].n}`));
} catch (err) {
  // A permission error (rather than zero rows) is also an acceptable
  // fail-safe outcome — it still leaks nothing — but zero rows is preferred
  // since that's what the RLS policies are designed to produce.
  if (/permission denied/i.test(err.message)) {
    ok('RLS: no auth.uid() (anon request) => permission denied (fail-safe, no leak)');
  } else {
    fail('RLS fail-safe (anon)', err);
  }
}

// ---- 3. System templates are visible to every tenant -----------------------

try {
  await asSuperuser(async () => {
    await db.query(
      `insert into template (tenant_id, layer, kind, code, title) values (null, 'system', 'checklist', 'readiness_tdt_install', 'Readiness — TDT instalação nova')`
    );
  });
  const r = await asUser(officeBAuthId, () =>
    db.query(`select count(*)::int as n from template where layer = 'system'`)
  );
  if (r.rows[0].n === 1) ok('RLS: system template visible cross-tenant as intended');
  else fail('system template visibility', new Error(`expected 1, got ${r.rows[0].n}`));
} catch (err) {
  fail('system template visibility', err);
}

// ---- 4. Unverified test_protocol cannot be activated (unchanged trigger) --

try {
  const tpl = await asUser(officeAAuthId, () =>
    db.query(
      `insert into template (tenant_id, layer, kind, code, title) values ($1, 'tenant', 'test_protocol', 'tdt_coax_v1', 'DVB-T2 coax test protocol') returning id`,
      [tenantA]
    )
  );
  const templateId = tpl.rows[0].id;

  let blocked = false;
  try {
    await asUser(officeAAuthId, () =>
      db.query(
        `insert into template_version (template_id, version, status, body) values ($1, 1, 'active', '{"network_type":"CC","tests":[]}')`,
        [templateId]
      )
    );
  } catch (err) {
    blocked = /unverified test_protocol/.test(err.message);
  }
  if (blocked) ok('gate: activating an unverified test_protocol is rejected');
  else fail('unverified test_protocol gate', new Error('activation was not blocked'));

  await asUser(officeAAuthId, () =>
    db.query(
      `insert into template_version (template_id, version, status, body, verified_by, verified_source, verified_at)
       values ($1, 2, 'active', '{"network_type":"CC","tests":[]}', $2, 'Manual ITED 4ª ed., p.168, Tabela 6.12', now())`,
      [templateId, officeAId]
    )
  );
  ok('gate: a verified test_protocol activates cleanly');
} catch (err) {
  fail('unverified test_protocol gate', err);
}

// ---- 5. REF <-> termo reconciliation trigger (unchanged) -------------------

try {
  const client = await asUser(officeAAuthId, () =>
    db.query(`insert into client (tenant_id, name) values ($1, 'Cliente REF') returning id`, [tenantA])
  );
  const job = await asUser(officeAAuthId, () =>
    db.query(
      `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
       values ($1, $2, 'JOB-9001', 'Teste REF', 'TDT novo', 3, 100) returning id`,
      [tenantA, client.rows[0].id]
    )
  );
  const jobId = job.rows[0].id;

  await asUser(officeAAuthId, () =>
    db.query(
      `insert into termo_responsabilidade (tenant_id, job_id, number, ref_id_field, issued_at) values ($1, $2, 'TR-0001', 'REF-2026-0042', now())`,
      [tenantA, jobId]
    )
  );

  let mismatchBlocked = false;
  try {
    await asUser(officeAAuthId, () =>
      db.query(
        `insert into ref_document (tenant_id, job_id, ref_id) values ($1, $2, 'REF-2026-DIFFERENT')`,
        [tenantA, jobId]
      )
    );
  } catch (err) {
    mismatchBlocked = /does not match/.test(err.message);
  }
  if (mismatchBlocked) ok('trigger: mismatched REF/termo id is rejected');
  else fail('REF/termo reconciliation', new Error('mismatch was not blocked'));

  await asUser(officeAAuthId, () =>
    db.query(
      `insert into ref_document (tenant_id, job_id, ref_id) values ($1, $2, 'REF-2026-0042')`,
      [tenantA, jobId]
    )
  );
  ok('trigger: matching REF/termo id inserts cleanly');
} catch (err) {
  fail('REF/termo reconciliation', err);
}

// ---- 6. Dashboard views compute, read through RLS via a real office user --

try {
  const client = await asUser(officeAAuthId, () =>
    db.query(`select id from client where tenant_id = $1 limit 1`, [tenantA])
  );
  const job = await asUser(officeAAuthId, () =>
    db.query(
      `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials, actual_hours)
       values ($1, $2, 'JOB-9002', 'Teste dashboard', 'TDT novo', 3.5, 214.6, 6.0) returning id`,
      [tenantA, client.rows[0].id]
    )
  );
  const jobId = job.rows[0].id;
  await asUser(officeAAuthId, async () => {
    await db.query(
      `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status) values
        ($1, $2, 'material', 'Antena', 'job', true, 'ok'),
        ($1, $2, 'material', 'Fonte 24V', 'job', true, 'missing')`,
      [tenantA, jobId]
    );
    await db.query(
      `insert into job_closeout (tenant_id, job_id, first_time_fix, closed_at) values ($1, $2, false, now())`,
      [tenantA, jobId]
    );
  });

  const readiness = await asUser(officeAAuthId, () =>
    db.query(`select readiness_pct from v_job_readiness where job_id = $1`, [jobId])
  );
  const ffr = await asUser(officeAAuthId, () =>
    db.query(`select ffr_pct from v_first_time_fix_rate where tenant_id = $1`, [tenantA])
  );

  if (Number(readiness.rows[0].readiness_pct) === 50.0) ok('view v_job_readiness computes 50.0% (read through RLS)');
  else fail('v_job_readiness', new Error(`got ${JSON.stringify(readiness.rows)}`));

  if (ffr.rows.length === 1) ok('view v_first_time_fix_rate returns a row (read through RLS)');
  else fail('v_first_time_fix_rate', new Error('no row returned'));
} catch (err) {
  fail('dashboard views', err);
}

// ---- 7. tenant table itself is RLS'd (the deliberate hardening this file's
// header comment calls out — 03-schema.sql left `tenant` unrestricted) -----

try {
  const seenAsA = await asUser(officeAAuthId, () => db.query(`select count(*)::int as n from tenant`));
  if (seenAsA.rows[0].n === 1) ok('RLS: tenant table itself only shows the caller\'s own tenant row');
  else fail('tenant table RLS', new Error(`expected 1 row (own tenant only), got ${seenAsA.rows[0].n}`));
} catch (err) {
  fail('tenant table RLS', err);
}

// ---- 8. Technician identity resolves through technician_device, not app_user
// directly (§2/§3's whole reason for existing) ------------------------------

try {
  const techUserId = crypto.randomUUID();
  await asSuperuser(() =>
    db.query(
      `insert into app_user (id, tenant_id, role, full_name) values ($1, $2, 'technician', 'Rui (técnico)')`,
      [techUserId, tenantA]
    )
  );

  techAAuthId = await createAuthUser(`device-${crypto.randomUUID()}@device.fieldready.internal`, '1234-device-secret');
  await asSuperuser(() =>
    db.query(
      `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by) values ($1, $2, 'Rui — telemóvel pessoal', $3, $4)`,
      [tenantA, techUserId, techAAuthId, officeAId]
    )
  );

  const resolved = await asUser(techAAuthId, async () => {
    const r = await db.query(`select fn_current_tenant_id() as tid`);
    return r.rows[0].tid;
  });

  if (resolved === tenantA) {
    ok('RLS: technician identity resolves to the right tenant through technician_device');
  } else {
    fail('technician identity resolution', new Error(`expected ${tenantA}, got ${resolved}`));
  }

  const seenByTech = await asUser(techAAuthId, () => db.query(`select count(*)::int as n from client`));
  const seenByOffice = await asUser(officeAAuthId, () => db.query(`select count(*)::int as n from client`));
  if (seenByTech.rows[0].n === seenByOffice.rows[0].n && seenByTech.rows[0].n > 0) {
    ok(`RLS: technician sees the same tenant-scoped rows as the office user (${seenByTech.rows[0].n}, via the device path)`);
  } else {
    fail('technician tenant-scoped read', new Error(
      `expected technician count to match office count, got tech=${seenByTech.rows[0].n} office=${seenByOffice.rows[0].n}`));
  }
} catch (err) {
  fail('technician identity resolution', err);
}

// ---- 9. Revoked device with a still-valid token is denied — the check that
// has NO equivalent in verify-schema.mjs at all, called out explicitly by
// 08-supabase-native-migration.md §3 as new and required, not optional. ----
// A Supabase Auth access token, once issued, stays valid until it expires on
// its own; revoking the device does not retroactively invalidate a token a
// client already holds. fn_current_tenant_id()'s `td.revoked_at is null`
// check is what has to catch this — not sign-in-time enforcement, which a
// still-valid token has already passed.

try {
  const revokedTechUserId = crypto.randomUUID();
  await asSuperuser(() =>
    db.query(
      `insert into app_user (id, tenant_id, role, full_name) values ($1, $2, 'technician', 'Device revoked before its token expired')`,
      [revokedTechUserId, tenantA]
    )
  );

  revokedTechAAuthId = await createAuthUser(`device-${crypto.randomUUID()}@device.fieldready.internal`, '9999-device-secret');
  await asSuperuser(() =>
    // revoked_at set at INSERT time — simulates "this token was issued, then
    // the device was revoked, and the token is presented again afterward"
    // without needing to actually wait out a real token lifetime.
    db.query(
      `insert into technician_device (tenant_id, user_id, device_label, auth_user_id, paired_by, revoked_at)
       values ($1, $2, 'Revoked device — stolen phone scenario', $3, $4, now())`,
      [tenantA, revokedTechUserId, revokedTechAAuthId, officeAId]
    )
  );

  const resolved = await asUser(revokedTechAAuthId, async () => {
    const r = await db.query(`select fn_current_tenant_id() as tid`);
    return r.rows[0].tid;
  });

  if (resolved === null) {
    ok('fn_current_tenant_id() returns null for a revoked device even with a valid token');
  } else {
    fail('revoked-device identity resolution', new Error(`expected null, got ${resolved}`));
  }

  const seenByRevoked = await asUser(revokedTechAAuthId, () => db.query(`select count(*)::int as n from client`));
  if (seenByRevoked.rows[0].n === 0) {
    ok('RLS: a revoked device with a still-valid token sees zero rows (the check this migration adds)');
  } else {
    fail('revoked-device RLS', new Error(`expected 0 rows for a revoked device, got ${seenByRevoked.rows[0].n}`));
  }
} catch (err) {
  fail('revoked-device identity resolution', err);
}

// ---- 10. Every non-tenant table has RLS enabled, same coverage check as
// verify-schema.mjs §7, rewritten for pg_roles/pg_class over a real connection

try {
  const r = await db.query(`
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'tenant'
      and c.relrowsecurity = false;
  `);
  if (r.rows.length === 0) {
    ok('every non-tenant table has row-level security enabled');
  } else {
    fail('RLS coverage', new Error(`tables missing RLS: ${r.rows.map(x => x.relname).join(', ')}`));
  }
} catch (err) {
  fail('RLS coverage', err);
}

// ---- cleanup: best-effort only — technician_device rows (which FK
// auth_user_id with no ON DELETE action, by design) are still live at this
// point, so revoked/paired test devices will 500 here exactly like the
// pre-sweep-fix run did. That's fine: the START-of-run sweep above is what
// actually guarantees no accumulation on the real project, by construction
// (it runs after the SQL reset removes the referencing rows) — this is just
// a courtesy attempt to leave less for that sweep to do next time.
console.log(`\nBest-effort cleanup of ${createdAuthUserIds.length} test auth user(s) from this run ...`);
let cleanedNow = 0;
for (const id of createdAuthUserIds) {
  if (await deleteAuthUser(id).catch(() => false)) cleanedNow++;
}
console.log(`  ${cleanedNow}/${createdAuthUserIds.length} deleted now; any rest will be swept at the start of the next run.`);

await db.end();

console.log('\n' + (failures === 0
  ? `All checks passed.`
  : `${failures} check(s) failed — see FAIL lines above.`));
process.exit(failures === 0 ? 0 : 1);
