// requirePlatformAdmin — the auth gate for apps/api/src/routes/platform-admin.ts.
// A platform admin has no tenant_id at all (schema.sql §2b's own comment:
// "operates across every tenant"), so this deliberately does NOT reuse
// requireAuth/SessionClaims (auth/middleware.ts) — that shape is
// fundamentally tenant-scoped (tenant_id, user_id, role all assume exactly
// one tenant), and forcing a platform admin into it would mean either a
// fake tenant_id (a real footgun waiting for something downstream to
// trust it) or weakening SessionClaims' own guarantees for everyone else.
// A separate, narrower gate for a separate, narrower identity model.
//
// Verifies the bearer token the same way auth/supabase-bridge.ts does
// (reusing its exported verifySupabaseUserId, not duplicating the HTTP
// call), then checks public.platform_admin directly via the same trusted
// withMigrator connection — the browser's own RLS-scoped session already
// enforces platform_admin_self_read for reads, but this route needs a
// definitive yes/no gate before doing anything, not "can this caller see
// a row", so it queries directly with the trusted connection rather than
// asking the caller's own Supabase session to prove it.

import type { FastifyRequest, FastifyReply } from "fastify";
import { verifySupabaseUserId } from "./supabase-bridge.js";
import { withMigrator } from "../db.js";

declare module "fastify" {
  interface FastifyRequest {
    platformAdmin?: { authUserId: string; id: string };
  }
}

export async function requirePlatformAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!bearerToken) {
    reply.code(401).send({ error: "unauthenticated", message: "No bearer token." });
    return;
  }

  const supabaseUserId = await verifySupabaseUserId(bearerToken);
  if (!supabaseUserId) {
    reply.code(401).send({ error: "invalid_session", message: "Bearer token did not resolve to a real Supabase user." });
    return;
  }

  const admin = await withMigrator((db) =>
    db.query<{ id: string }>(`select id from public.platform_admin where auth_user_id = $1;`, [supabaseUserId])
  );
  if (admin.rows.length === 0) {
    reply.code(403).send({ error: "not_platform_admin", message: "This account is not a platform admin." });
    return;
  }

  req.platformAdmin = { authUserId: supabaseUserId, id: admin.rows[0].id };
}
