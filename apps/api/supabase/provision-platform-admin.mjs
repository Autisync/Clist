// FieldReady — real platform-admin provisioning. Technician-auth migration
// follow-up (schema.sql §2b).
//
// Mirrors provision-tenant.mjs exactly, for the same reason: no self-service
// path creates a platform_admin row (schema.sql's own comment on that
// table), so this script IS the bootstrap step, run by hand against the
// trusted service-role connection. Once at least one platform_admin row
// exists, routes/platform-admin.ts's own endpoints (gated by
// fn_is_platform_admin()) are how everything after that first row gets
// created — this script is only for creating the FIRST one (or any
// subsequent one you choose to create the same trusted way rather than
// through a UI that doesn't exist for this yet either).
//
// Creates, in order: a real Supabase Auth user (Admin API, service_role)
// and the platform_admin row linking it — no tenant, no app_user, on
// purpose (schema.sql's own comment: "operates across every tenant").
//
// Usage:
//   cd apps/api && node --env-file=.env supabase/provision-platform-admin.mjs \
//     --name "Rex" --email dpolisousa@gmail.com --password "<a real password>"

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
const required = ['name', 'email', 'password'];
const missing = required.filter((k) => !args[k]);
if (missing.length > 0) {
  console.error(
    `Missing required arguments: ${missing.map((k) => `--${k}`).join(', ')}\n\n` +
    'Usage: node supabase/provision-platform-admin.mjs --name "..." --email "..." --password "..."'
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
const db = new Client(pgClientConfig(projectRef, dbPassword));
await db.connect();

try {
  const existing = await db.query(
    `select pa.id from platform_admin pa
     join auth.users u on u.id = pa.auth_user_id
     where u.email = $1`,
    [args.email]
  );
  if (existing.rows.length > 0) {
    console.error(
      `A platform admin already exists for ${args.email} (platform_admin.id ${existing.rows[0].id}). ` +
      `Refusing to create a duplicate.`
    );
    await db.end();
    process.exit(1);
  }

  // If this email already has a Supabase Auth user (e.g. they're also an
  // office user of some tenant), reuse that identity rather than failing —
  // one real person can plausibly be both a platform admin and, separately,
  // an office user somewhere. Admin API createUser would 422 on a duplicate
  // email, so check first rather than relying on that error to detect it.
  //
  // Real, dangerous bug found running this script for the first time, not
  // anticipated: GoTrue's List Users admin endpoint SILENTLY IGNORES the
  // `?email=` query parameter entirely — confirmed directly against the
  // real Admin API, not assumed — and just returns whatever page of ALL
  // users happens to come back. The original version of this script took
  // `users[0].id` on blind faith and, in the one real run that hit this
  // branch, updated the PASSWORD of a completely unrelated leftover test
  // fixture's auth user (a paired technician device's synthetic identity
  // from an earlier proof run) — not this email at all. Fixed by fetching
  // a large page and filtering client-side for an EXACT email match,
  // never trusting the query param to have done anything.
  const lookupRes = await fetch(`${authApiBase}/admin/users?page=1&per_page=1000`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  const lookupBody = await lookupRes.json();
  const matched = (lookupBody?.users ?? []).find((u) => u.email === args.email);
  let authUserId = matched?.id;

  if (authUserId) {
    // Real bug caught testing this script, not anticipated: reusing the
    // existing user without also setting the password means the "sign in
    // with the password you provided" message at the end would be false —
    // whatever password that account already had (from whenever IT was
    // created) stays in effect, silently, while this script's own output
    // claims otherwise. Explicitly setting it here makes the printed
    // instruction actually true regardless of which branch ran.
    const updateRes = await fetch(`${authApiBase}/admin/users/${authUserId}`, {
      method: 'PUT',
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: args.password }),
    });
    if (!updateRes.ok) {
      console.error(`Failed to set the password on the existing Supabase Auth user: ${updateRes.status} ${JSON.stringify(await updateRes.json())}`);
      await db.end();
      process.exit(1);
    }
    console.log(`Reusing existing Supabase Auth user for ${args.email}, id=${authUserId} (password updated to the one you provided)`);
  } else {
    const authRes = await fetch(`${authApiBase}/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: args.email,
        password: args.password,
        email_confirm: true,
      }),
    });
    const authBody = await authRes.json();
    if (!authRes.ok) {
      console.error(`Failed to create the Supabase Auth user: ${authRes.status} ${JSON.stringify(authBody)}`);
      await db.end();
      process.exit(1);
    }
    authUserId = authBody.id;
    console.log(`Created Supabase Auth user for ${args.email}, id=${authUserId}`);
  }

  const admin = await db.query(
    `insert into platform_admin (auth_user_id, full_name) values ($1, $2) returning id`,
    [authUserId, args.name]
  );
  console.log(`Created platform_admin row, id=${admin.rows[0].id}`);
  console.log(`\nDone. ${args.name} can sign in at /admin/login as ${args.email} with the password you provided.`);
} catch (err) {
  console.error('Provisioning failed:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
