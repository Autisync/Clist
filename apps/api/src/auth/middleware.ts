// requireAuth — resolves the session cookie to (tenant_id, user_id, role)
// and attaches it to the request. Architecture §3: this is the only place
// tenant_id enters a request; no route ever reads it from the client.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionClaims } from "@fieldready/core";
import { verifySession } from "./tokens.js";
import { resolveSupabaseClaims } from "./supabase-bridge.js";
import { withMigrator } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: SessionClaims;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.fr_session;

  let claims: SessionClaims;
  if (token) {
    try {
      claims = verifySession(token);
    } catch {
      reply.code(401).send({ error: "invalid_session", message: "Session token is invalid or expired." });
      return;
    }
  } else {
    // No fr_session cookie -- the classic system's own login route was
    // never called. A real Supabase-only caller (every real office user
    // today, per §6 Step 5's login-page cutover) falls here, not into the
    // branch above -- supabase-bridge.ts's own comment has the full story
    // on why this exists at all.
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!bearerToken) {
      reply.code(401).send({ error: "unauthenticated", message: "No session cookie or bearer token." });
      return;
    }
    const resolved = await resolveSupabaseClaims(bearerToken);
    if (!resolved) {
      reply.code(401).send({ error: "invalid_session", message: "Bearer token did not resolve to a known session." });
      return;
    }
    claims = resolved;
  }

  // Device-bound technician sessions: a signed JWT alone can't resurrect a
  // revoked device (architecture §7) — check on every request, not just at
  // login. Classic (fr_session) path only: `claims.device_id` there is a
  // classic-schema technician_device.id, and this query is deliberately
  // unqualified (search_path = FASTIFY_SCHEMA) to match it. A Supabase-
  // bridge-resolved claim (the `else` branch above) already did the
  // equivalent check against public.technician_device inside
  // resolveSupabaseClaims itself, against a different table with a
  // different id space — running this same query again for that path
  // would look up the wrong table entirely and reject every technician
  // bridge request as falsely revoked (`rows.length === 0` below treats
  // "not found" as "revoked", which is correct for the classic table but
  // wrong here).
  if (token && claims.role === "technician" && claims.device_id) {
    const revoked = await withMigrator(async (db) => {
      const r = await db.query<{ revoked_at: string | null }>(
        `select revoked_at from technician_device where id = $1;`,
        [claims.device_id]
      );
      return r.rows[0]?.revoked_at != null || r.rows.length === 0;
    });
    if (revoked) {
      reply.code(401).send({ error: "device_revoked", message: "This device has been revoked." });
      return;
    }
  }

  req.auth = claims;
}
