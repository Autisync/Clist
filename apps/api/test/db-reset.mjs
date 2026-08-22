// Shared by all four proof scripts (phase1-4). Real-Postgres swap
// (apps/api/src/db.ts): db.ts now persists into a real, shared Postgres
// project instead of a per-run on-disk PGlite directory, so "clean slate
// before this run" and "reach the data directly while the server's down"
// (the SIGKILL-then-mutate-then-restart pattern every proof script uses at
// least once) can no longer be a filesystem operation on RUNTIME_DIR — both
// now go through this same real connection instead.
//
// Each proof script gets its OWN dedicated schema name (mirroring the
// distinct RUNTIME_DIR each already used under PGlite, so the four proofs
// still never share data even run back-to-back), never the bare
// "fastify_api" default db.ts falls back to for real local dev — dropping
// that would destroy a developer's actual local data.

import pg from "pg";

function requireConnectionEnv() {
  const { SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD } = process.env;
  if (!SUPABASE_PROJECT_REF || !SUPABASE_DB_PASSWORD) {
    throw new Error(
      "SUPABASE_PROJECT_REF / SUPABASE_DB_PASSWORD must be set (apps/api/.env) — proof scripts " +
        "now reset/reach a real Postgres schema before/during each run, not an on-disk PGlite directory. " +
        "Run via `npm run proof*` from repo root (already wired to load apps/api/.env)."
    );
  }
  return { SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD };
}

// Same hosting-portability fix as src/db.ts's own SUPABASE_DB_POOLER_HOST
// (see that file's comment for the full "direct connection is IPv6-only,
// confirmed empirically" reasoning) — a CI runner without real IPv6 egress
// would otherwise fail every one of these proof scripts at the very first
// schema-reset step, not just at server boot.
function connectionParams(searchPath) {
  const { SUPABASE_PROJECT_REF, SUPABASE_DB_PASSWORD } = requireConnectionEnv();
  const poolerHost = process.env.SUPABASE_DB_POOLER_HOST;
  const base = {
    password: SUPABASE_DB_PASSWORD,
    database: "postgres",
    ssl: { rejectUnauthorized: false },
  };
  const host = poolerHost ?? `db.${SUPABASE_PROJECT_REF}.supabase.co`;
  const user = poolerHost ? `postgres.${SUPABASE_PROJECT_REF}` : "postgres";
  return searchPath
    ? { ...base, host, port: 5432, user, options: `-c search_path=${searchPath}` }
    : { ...base, host, port: 5432, user };
}

/** Drops `schemaName` (cascade) so the next server boot re-applies
 * schema+seed+fixtures from scratch — the same "totally clean slate" a
 * `rmSync(RUNTIME_DIR)` used to give against an on-disk PGlite file. Safe
 * even the first time a schema never existed (`if exists`). */
export async function resetFastifySchema(schemaName) {
  const client = new pg.Client(connectionParams());
  await client.connect();
  try {
    await client.query(`drop schema if exists "${schemaName}" cascade;`);
  } finally {
    await client.end();
  }
}

/** Opens a direct connection into `schemaName`, for the same
 * "server is SIGKILLed, mutate data no HTTP route reaches, restart, confirm
 * over HTTP" pattern the proof scripts already used against a direct PGlite
 * handle — same `.query(sql, params) -> {rows}` shape, so call sites are
 * otherwise unchanged. Caller must `.end()` it before restarting the
 * server (never two things touching the same row concurrently, same
 * discipline the old PGlite version enforced by file-level exclusivity). */
export async function openDirectConnection(schemaName) {
  const client = new pg.Client(connectionParams(schemaName));
  await client.connect();
  return client;
}
