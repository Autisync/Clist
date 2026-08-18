// requireAuth — resolves the session cookie to (tenant_id, user_id, role)
// and attaches it to the request. Architecture §3: this is the only place
// tenant_id enters a request; no route ever reads it from the client.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { SessionClaims } from "@fieldready/core";
import { verifySession } from "./tokens.js";
import { withMigrator } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: SessionClaims;
  }
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.cookies?.fr_session;
  if (!token) {
    reply.code(401).send({ error: "unauthenticated", message: "No session cookie." });
    return;
  }

  let claims: SessionClaims;
  try {
    claims = verifySession(token);
  } catch {
    reply.code(401).send({ error: "invalid_session", message: "Session token is invalid or expired." });
    return;
  }

  // Device-bound technician sessions: a signed JWT alone can't resurrect a
  // revoked device (architecture §7) — check on every request, not just at
  // login.
  if (claims.role === "technician" && claims.device_id) {
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
