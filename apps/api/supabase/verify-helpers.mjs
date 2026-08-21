// FieldReady — shared helpers for the Supabase-native migration's verify
// scripts (verify-schema-supabase.mjs, verify-office-auth.mjs). Factored out
// after a security review found the two scripts had drifted: the auth-user
// sweep added to one (specifically to stop orphaned Supabase Auth test users
// from accumulating on the real project after a failed run) was never
// ported to the other, which duplicated the same createAuthUser/
// deleteAuthUser pattern byte-for-byte without it. One copy now, so a safety
// fix here reaches both call sites automatically instead of needing to be
// separately noticed and re-applied.

export function createReporter() {
  let failures = 0;
  return {
    ok(label) { console.log(`  OK   ${label}`); },
    fail(label, err) { failures++; console.log(`  FAIL ${label} -> ${err.message ?? err}`); },
    get failures() { return failures; },
  };
}

export function pgClientConfig(projectRef, dbPassword) {
  return {
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password: dbPassword,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  };
}

// Real Supabase Auth Admin API helpers. createdAuthUserIds is the caller's
// own array (not owned by this module) so the caller can walk it for
// cleanup from more than one place — including a catch block on a partial
// failure, which is exactly the gap this factoring closes (see
// verify-office-auth.mjs's fixture-setup try/catch, which now cleans up on
// the failure path too, not just the success path).
export function createAuthAdmin({ authApiBase, serviceRoleKey, createdAuthUserIds }) {
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

  // Sweep every auth.users row either script could have created, by the
  // fixed email suffix all of them share — not just this run's own
  // createdAuthUserIds — so stragglers from an interrupted/failed prior run
  // (of EITHER script) don't accumulate on the real project forever. Only
  // safe to call after any referencing technician_device rows are gone
  // (auth_user_id has no ON DELETE action, by design — see schema.sql's
  // comment on that table) or every delete 500s on "still referenced from
  // table technician_device".
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

  return { createAuthUser, deleteAuthUser, sweepTestAuthUsers };
}

// ---- simulate PostgREST's request context inside a real transaction ------
// Supabase's own documented pattern for exercising RLS from a direct SQL
// connection: `set local role`, then the JWT claims PostgREST would have
// set, as local (transaction-scoped) GUCs. auth.uid() reads either
// request.jwt.claim.sub or request.jwt.claims->>'sub' depending on Supabase
// project version — both are set below so this doesn't depend on which.
export function createSessionSimulator(db) {
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

  return { asUser, asAnon, asSuperuser };
}
