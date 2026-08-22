// FieldReady — real tenant + office-user provisioning. §6 Step 5.
//
// There is no self-serve signup UI (08-supabase-native-migration.md §2: "a
// small, unavoidably server-side" step is the only place service_role is
// allowed to touch auth — creating a Supabase Auth user requires it). This
// script IS that step for office users, run by hand/CLI rather than from a
// web form — the equivalent of what a real "create my company's account"
// flow will eventually wrap, once one is built.
//
// Creates, in order: a real tenant row, a real Supabase Auth user (Admin
// API, service_role), and the app_user row linking them
// (auth_user_id = the new Supabase Auth user's id) — the office half of
// §2's identity model, no synthetic email involved (that's only for
// technician devices).
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/provision-tenant.mjs \
//     --tenant-name "Antenas Rex, Lda" --tenant-slug antenas-rex \
//     --compliance-profile ited_ready \
//     --office-name "Rex" --office-email dpolisousa@gmail.com \
//     --office-password "<a real password>"
//
// Idempotent-ish: re-running with the same --tenant-slug fails loudly on
// the tenant's unique(slug) constraint rather than silently creating a
// duplicate — this is real, persistent data, not a test fixture reset on
// every run.

import { Client } from 'pg';
import { pgClientConfig } from './verify-helpers.mjs';

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  return args;
}

const args = parseArgs();
const required = ['tenant-name', 'tenant-slug', 'office-name', 'office-email', 'office-password'];
const missing = required.filter((k) => !args[k]);
if (missing.length > 0) {
  console.error(
    `Missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}\n\n` +
    'Usage: node supabase/provision-tenant.mjs --tenant-name "..." --tenant-slug "..." ' +
    '[--compliance-profile basic|ited_ready|ited_full] --office-name "..." --office-email "..." --office-password "..."'
  );
  process.exit(1);
}

const projectRef = process.env.SUPABASE_PROJECT_REF;
const dbPassword = process.env.SUPABASE_DB_PASSWORD;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!projectRef || !dbPassword || !serviceRoleKey) {
  console.error('Missing SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const authApiBase = `https://${projectRef}.supabase.co/auth/v1`;
const complianceProfile = args['compliance-profile'] ?? 'ited_ready';
if (!['basic', 'ited_ready', 'ited_full'].includes(complianceProfile)) {
  console.error(`--compliance-profile must be one of basic, ited_ready, ited_full — got "${complianceProfile}"`);
  process.exit(1);
}

const db = new Client(pgClientConfig(projectRef, dbPassword));
await db.connect();

try {
  const existing = await db.query(`select id from tenant where slug = $1`, [args['tenant-slug']]);
  if (existing.rows.length > 0) {
    console.error(
      `A tenant with slug "${args['tenant-slug']}" already exists (id ${existing.rows[0].id}). ` +
      `Refusing to create a duplicate — this is real, persistent data, not a test fixture.`
    );
    await db.end();
    process.exit(1);
  }

  const tenant = await db.query(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, $3) returning id`,
    [args['tenant-name'], args['tenant-slug'], complianceProfile]
  );
  const tenantId = tenant.rows[0].id;
  console.log(`Created tenant "${args['tenant-name']}" (${args['tenant-slug']}), id=${tenantId}, compliance_profile=${complianceProfile}`);

  const authRes = await fetch(`${authApiBase}/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: args['office-email'],
      password: args['office-password'],
      email_confirm: true, // no real email is sent; this is the account owner setting it up directly
    }),
  });
  const authBody = await authRes.json();
  if (!authRes.ok) {
    console.error(`Failed to create the Supabase Auth user: ${authRes.status} ${JSON.stringify(authBody)}`);
    console.error('Rolling back: deleting the tenant row just created.');
    await db.query(`delete from tenant where id = $1`, [tenantId]);
    await db.end();
    process.exit(1);
  }
  const authUserId = authBody.id;
  console.log(`Created Supabase Auth user for ${args['office-email']}, id=${authUserId}`);

  const appUser = await db.query(
    `insert into app_user (auth_user_id, tenant_id, role, full_name, email) values ($1, $2, 'owner', $3, $4) returning id`,
    [authUserId, tenantId, args['office-name'], args['office-email']]
  );
  console.log(`Created app_user (role=owner) linking them, id=${appUser.rows[0].id}`);

  console.log(
    `\nDone. ${args['office-name']} can sign in as ${args['office-email']} with the password you provided ` +
    `once the office login page is wired to Supabase Auth.`
  );
} catch (err) {
  console.error('Provisioning failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
