// Database layer — architecture §3 (RLS is the real isolation mechanism,
// not just a filter).
//
// The real-Postgres swap this file's own original comment anticipated
// ("Swapping to a real Postgres server for production... means changing
// this file's connection setup only") — PGlite (an in-process, on-disk WASM
// Postgres, explicitly a Phase 1 stand-in) is replaced with a real
// connection pool. Every query, policy, and trigger in 03-schema.sql stays
// exactly as written; this file only changes HOW a connection is made and
// WHERE its DDL lands, never WHAT the DDL says.
//
// The real server is the SAME Supabase Postgres project already proven
// throughout the Supabase-native migration (08-supabase-native-migration.md)
// — used here in a completely different way: a plain, trusted-backend
// connection (the `postgres` role, no RLS/anon-key involved), scoped to its
// own dedicated schema (FASTIFY_SCHEMA, not `public`) specifically so this
// classic system's tables can never collide with the real, RLS-governed
// production data the Supabase-native pages already serve from `public`.
// Two genuinely separate table sets, one Postgres server — no new external
// resource to provision, and easy to tear this whole schema down once the
// Supabase-native cutover is complete and this file's job is done for good.

import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seedPhase1Fixtures } from "./fixtures.js";

const { Pool } = pg;

// PGlite (like most Postgres drivers, this file's own earlier comment
// notwithstanding — confirmed directly against a real table column, not
// assumed) returns `date` columns as JS Date objects, not plain strings.
// domain/dispatch-gate.ts found a real bug that fell out of trusting that
// wrong assumption (a Date-vs-string `<` comparison that silently never
// worked) and now normalizes explicitly rather than relying on a
// particular driver shape — but pinning `pg`'s date parser back to a raw
// string here keeps behavior identical to what PGlite already produced for
// every other place in the codebase that never hit that particular bug,
// so this swap doesn't have to also be an audit of every date comparison
// in the app. OID 1082 = date.
pg.types.setTypeParser(1082, (value) => value);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");

const FASTIFY_SCHEMA = process.env.FASTIFY_DB_SCHEMA || "fastify_api";

let _pool: pg.Pool | undefined;

function getConnectionConfig(): pg.PoolConfig {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const dbPassword = process.env.SUPABASE_DB_PASSWORD;
  if (!projectRef || !dbPassword) {
    throw new Error(
      "SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD must be set — apps/api now connects to a " +
        "real Postgres server (see apps/api/README.md's real-Postgres-swap section), not PGlite."
    );
  }

  // Hosting-portability fix, confirmed empirically (not assumed): the
  // direct connection host (db.<ref>.supabase.co) resolves to an
  // IPv6-only address — Supabase's own docs say so outright, and it's
  // easy to reproduce locally (any environment without real IPv6 egress
  // gets ENOTFOUND/"Network is unreachable", exactly what a real Docker
  // build of this same image hit). Real hosting platforms' outbound IPv6
  // support varies (confirmed: Render has none as of this writing; even
  // Fly.io, which generally has IPv6 egress, has had real regional IPv6
  // outages reported against Supabase specifically) — so rather than bet
  // on any given host's IPv6 posture, SUPABASE_DB_POOLER_HOST switches
  // this connection to Supabase's own Supavisor pooler instead, which is
  // IPv4-reachable and is Supabase's own documented recommendation for
  // exactly this situation. Confirmed empirically to behave identically
  // to the direct connection for everything this file depends on: the
  // `-c search_path=...` startup option, and SET LOCAL role actually
  // switching current_user for the duration of a transaction and
  // reverting after commit. Optional and additive — unset, this falls
  // back to the direct connection exactly as before (correct for local
  // dev environments that do have real IPv6 route-ability, confirmed:
  // this repo's own dev sandbox is one).
  const poolerHost = process.env.SUPABASE_DB_POOLER_HOST;
  if (poolerHost) {
    return {
      host: poolerHost,
      port: 5432, // session mode, not the 6543 transaction-pooling port —
      // needed for SET LOCAL role/app.current_tenant_id to actually take
      // effect for the rest of withTenant()'s transaction the way a plain
      // session connection guarantees; confirmed working via session mode,
      // not re-verified against transaction mode.
      user: `postgres.${projectRef}`, // Supavisor's own user-encodes-the-
      // project convention, not a typo of the direct connection's plain
      // "postgres" — confirmed empirically (the plain form gets rejected
      // with "tenant/user ... not found" against the pooler).
      password: dbPassword,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      options: `-c search_path=${FASTIFY_SCHEMA}`,
    };
  }

  return {
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    user: "postgres",
    password: dbPassword,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
    // Every connection in this pool defaults to FASTIFY_SCHEMA — set once
    // at connection start via a startup option, not re-set per query.
    options: `-c search_path=${FASTIFY_SCHEMA}`,
  };
}

function wrapAsDbTx(runner: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}): DbTx {
  return {
    query: (sql, params) => runner.query(sql, params) as Promise<{ rows: never[] }>,
    exec: (sql) => runner.query(sql),
  };
}

async function schemaAlreadyApplied(client: pg.PoolClient): Promise<boolean> {
  const r = await client.query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = $1 and table_name = 'tenant'
     ) as exists;`,
    [FASTIFY_SCHEMA]
  );
  return Boolean(r.rows[0]?.exists);
}

/** Boots (or reconnects to) the real-Postgres-backed pool, applying
 * 03-schema.sql + seed.sql + Phase 1 fixtures exactly once, into its own
 * dedicated schema. Safe to call repeatedly across process restarts — a
 * killed-and-restarted server reconnects to data that already survived it
 * (Phase 1 exit criterion, CLAUDE.md), the same guarantee as always, just
 * against a real server now instead of an on-disk PGlite file (which,
 * unlike a real server, meant "restart" and "reconnect to the same data"
 * were only true because the file itself never moved — a real server
 * makes that guarantee for a much more ordinary reason: it just kept
 * running the whole time). */
export async function getDb(): Promise<pg.Pool> {
  if (_pool) return _pool;

  const pool = new Pool(getConnectionConfig());
  const client = await pool.connect();
  try {
    await client.query(`create schema if not exists ${FASTIFY_SCHEMA};`);
    const alreadyApplied = await schemaAlreadyApplied(client);

    if (!alreadyApplied) {
      const schemaSql = readFileSync(path.join(REPO_ROOT, "03-schema.sql"), "utf8")
        // The one deployment-specific adjustment to an otherwise
        // unmodified 03-schema.sql: this deployment owns FASTIFY_SCHEMA,
        // not `public` — real, RLS-governed production data already lives
        // there (this file's header comment) — and 03-schema.sql's only
        // reference to `public` at all is this one grant.
        .replace(
          "grant usage on schema public to fieldready_app;",
          `grant usage on schema ${FASTIFY_SCHEMA} to fieldready_app;`
        );
      const seedSql = readFileSync(path.join(REPO_ROOT, "seed.sql"), "utf8");

      await client.query(schemaSql);
      // Supabase-specific requirement, verified empirically before relying
      // on it (not assumed): the `postgres` role here can SET LOCAL ROLE
      // to Supabase's own built-in roles (authenticated/anon/service_role)
      // with no explicit grant, but NOT to a brand-new custom role like
      // fieldready_app without one — confirmed directly against the real
      // project (SET LOCAL ROLE failed with "permission denied" until this
      // grant was added). A traditional standalone Postgres server —
      // where you'd typically connect as whichever role created
      // fieldready_app in the first place — wouldn't need this at all.
      await client.query(`grant fieldready_app to postgres;`);
      await client.query(seedSql);
      await seedPhase1Fixtures(wrapAsDbTx(client));
    }
  } finally {
    client.release();
  }

  _pool = pool;
  return pool;
}

/** Runs `fn` inside a transaction with RLS actually enforced — `SET LOCAL
 * role fieldready_app; SET LOCAL app.current_tenant_id = ...` before
 * anything else, exactly the pattern architecture §3 requires of every
 * request handler and that verify-schema.mjs already proves isolates
 * tenants. tenantId must come from the verified session, never a client
 * field (API spec §1). A dedicated client is checked out of the pool for
 * the whole transaction (SET LOCAL is transaction/connection-scoped) and
 * always released back to the pool, success or failure — unlike PGlite's
 * single embedded instance, a real pool means concurrent requests from
 * different tenants now genuinely run on separate connections instead of
 * serializing through one. */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: DbTx) => Promise<T>
): Promise<T> {
  const pool = await getDb();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role fieldready_app;`);
    await client.query(`select set_config('app.current_tenant_id', $1, true);`, [tenantId]);
    const result = await fn(wrapAsDbTx(client));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The one intentionally-elevated path in this codebase: login has no
 * tenant context yet (that's what it's resolving), so the credential
 * lookup by email necessarily runs before RLS has anything to scope by.
 * Used ONLY inside the login handlers to find/verify a user row — never to
 * serve tenant data. Everything else in the app goes through withTenant.
 * Runs as the pool's own connecting role (postgres — the role that owns
 * the tables), same as migrations do, not a new privilege invented for
 * this deployment. */
export async function withMigrator<T>(fn: (db: DbTx) => Promise<T>): Promise<T> {
  const pool = await getDb();
  return fn(wrapAsDbTx(pool));
}

// Minimal structural type so route/domain files don't need to import `pg`'s
// client/pool types directly. Named DbTx (not PGliteTx, this type's former
// name before the real-Postgres swap) since it's no longer PGlite-specific
// — every existing route/domain file that imported the old name was
// updated to this one, a purely mechanical rename verified by a full
// typecheck, not a behavior change.
export type DbTx = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<unknown>;
};
