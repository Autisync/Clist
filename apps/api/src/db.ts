// Database layer — architecture §3 (RLS is the real isolation mechanism,
// not just a filter) and §2 (PostgreSQL 16+ via Drizzle in the long run).
//
// Phase 1 substitution, noted plainly: this sandboxed dev environment has
// no Docker/root, so there's no real Postgres server to point at. PGlite is
// real Postgres (compiled to WASM) running in-process — same SQL, same RLS
// semantics, same triggers, verified against it already by verify-schema.mjs
// and verify-seed.mjs in this repo. Swapping to a real Postgres server for
// production (Fly Postgres/Neon, per architecture §2) means changing this
// file's connection setup only; every query, policy, and trigger stays
// identical because they're already real Postgres, not an approximation of
// one. Drizzle is deferred past this proof for the same reason raw SQL was
// used in the verification harnesses: fewer places a schema/ORM mismatch
// could hide while the foundational risk (RLS, sync, auth) is what's being
// proven.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { seedPhase1Fixtures } from "./fixtures.js";
import { RUNTIME_DIR } from "./runtime-dir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../");

const DATA_DIR = path.join(RUNTIME_DIR, "pglite");

let _db: PGlite | undefined;

async function schemaAlreadyApplied(db: PGlite): Promise<boolean> {
  const r = await db.query<{ exists: boolean }>(
    `select exists (select 1 from information_schema.tables where table_name = 'tenant') as exists;`
  );
  return Boolean(r.rows[0]?.exists);
}

/** Boots (or reconnects to) the PGlite-backed database, applying
 * 03-schema.sql + seed.sql + Phase 1 fixtures exactly once. Safe to call
 * repeatedly across process restarts against the same PGLITE_DATA_DIR — the
 * whole point is that a killed-and-restarted server reconnects to data that
 * already survived it (Phase 1 exit criterion, CLAUDE.md). */
export async function getDb(): Promise<PGlite> {
  if (_db) return _db;

  mkdirSync(path.dirname(DATA_DIR), { recursive: true });
  const db = new PGlite(DATA_DIR);
  const alreadyApplied = await schemaAlreadyApplied(db);

  if (!alreadyApplied) {
    const schemaSql = readFileSync(path.join(REPO_ROOT, "03-schema.sql"), "utf8");
    const seedSql = readFileSync(path.join(REPO_ROOT, "seed.sql"), "utf8");
    await db.exec(schemaSql);
    await db.exec(seedSql);
    await seedPhase1Fixtures(db);
  }

  _db = db;
  return db;
}

/** Runs `fn` inside a transaction with RLS actually enforced — `SET LOCAL
 * role fieldready_app; SET LOCAL app.current_tenant_id = ...` before
 * anything else, exactly the pattern architecture §3 requires of every
 * request handler and that verify-schema.mjs already proves isolates
 * tenants. tenantId must come from the verified session, never a client
 * field (API spec §1). */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: PGliteTx) => Promise<T>
): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.exec(`set local role fieldready_app;`);
    await tx.query(`select set_config('app.current_tenant_id', $1, true);`, [tenantId]);
    return fn(tx as unknown as PGliteTx);
  });
}

/** The one intentionally-elevated path in this codebase: login has no
 * tenant context yet (that's what it's resolving), so the credential
 * lookup by email necessarily runs before RLS has anything to scope by.
 * Used ONLY inside the login handlers to find/verify a user row — never to
 * serve tenant data. Everything else in the app goes through withTenant.
 * Real deployment: this becomes a query against a real Postgres connection
 * using a role that owns the tables, same as migrations do — not a new
 * privilege invented for this. */
export async function withMigrator<T>(fn: (db: PGlite) => Promise<T>): Promise<T> {
  const db = await getDb();
  return fn(db);
}

// Minimal structural type so route files don't need to import PGlite's
// transaction type directly.
export type PGliteTx = {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  exec: (sql: string) => Promise<unknown>;
};
