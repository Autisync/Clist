// 04-API-SPEC.md §1. Magic-link login is named there as an alternative to
// password for office users but not implemented here — Phase 1 needs one
// working office credential path to prove the auth+RLS wiring, not both;
// adding it later is a new token table and a route, not a redesign.

import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import {
  OfficeLoginRequest,
  TechnicianPairRequest,
  TechnicianLoginRequest,
} from "@fieldready/core";
import { withMigrator, withTenant } from "../db.js";
import { signOfficeSession, signTechnicianSession } from "../auth/tokens.js";
import { requireAuth } from "../auth/middleware.js";

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  // secure: true belongs here once this is served over HTTPS in deployment
  // (architecture §7) — off here only because the proof runs over plain
  // HTTP against localhost.
};

// Tighter than server.ts's global default (300/min) — these three are the
// only unauthenticated, credential-guessing-prone endpoints this whole API
// has: a password (office), a PIN (technician), and an invite-token-as-
// bearer (pairing). 10/minute per IP is generous for a real typo/retry,
// tight enough to make brute-forcing a password or a 4-digit PIN
// impractical. Inherits server.ts's loopback allowList (no allowList set
// here), so the existing proof suite's own repeated office-login/pairing
// calls from 127.0.0.1 stay unaffected.
const LOGIN_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/office/login", LOGIN_RATE_LIMIT, async (req, reply) => {
    const body = OfficeLoginRequest.parse(req.body);

    const user = await withMigrator(async (db) => {
      // Intentionally RLS-bypassing lookup — see db.ts withMigrator comment.
      // Known Phase 1 simplification: email isn't required globally unique
      // (schema unique constraint is per-tenant), so this takes the first
      // match. A real "which company?" disambiguation step is Phase 2+.
      const r = await db.query<{
        id: string; tenant_id: string; role: string; password_hash: string | null; active: boolean;
      }>(
        `select id, tenant_id, role, password_hash, active from app_user
         where email = $1 and password_hash is not null limit 1;`,
        [body.email]
      );
      return r.rows[0];
    });

    if (!user || !user.active || !user.password_hash) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = signOfficeSession({
      tenant_id: user.tenant_id,
      user_id: user.id,
      role: user.role as "owner" | "office",
    });
    reply.setCookie("fr_session", token, COOKIE_OPTS);
    return reply.send({ ok: true, role: user.role });
  });

  app.post("/auth/office/logout", { preHandler: requireAuth }, async (req, reply) => {
    reply.clearCookie("fr_session", { path: "/" });
    return reply.send({ ok: true });
  });

  app.post("/auth/technician/pair", LOGIN_RATE_LIMIT, async (req, reply) => {
    // Office-issued invite, not self-registration (architecture §7). Phase 1
    // simplification: the "invite token" is the inviting office user's id —
    // enough to prove device pairing is office-gated without building a
    // full invite-token table/expiry flow that nothing downstream depends
    // on yet.
    const body = TechnicianPairRequest.parse(req.body);

    const result = await withMigrator(async (db) => {
      const inviter = await db.query<{ id: string; tenant_id: string; role: string }>(
        `select id, tenant_id, role from app_user where id = $1 and role in ('owner','office');`,
        [body.inviteToken]
      );
      if (inviter.rows.length === 0) return null;
      const { tenant_id } = inviter.rows[0];

      const pinHash = await bcrypt.hash(body.pin, 10);
      return withTenant(tenant_id, async (tx) => {
        const technician = await tx.query<{ id: string }>(
          `select id from app_user where id = $1 and tenant_id = $2 and role = 'technician';`,
          [body.inviteToken, tenant_id]
        );
        // The invite token identifies the office issuer, not the technician
        // being paired — for Phase 1's proof, pairing attaches the device to
        // the same office user's tenant on a synthetic technician row if one
        // isn't specified. Real UX: office picks the technician from a list;
        // out of scope here (architecture §8).
        const technicianId = technician.rows[0]?.id ?? inviter.rows[0].id;
        const device = await tx.query<{ id: string }>(
          `insert into technician_device (tenant_id, user_id, device_label, pin_hash, paired_by)
           values ($1, $2, $3, $4, $5) returning id;`,
          [tenant_id, technicianId, body.deviceLabel, pinHash, inviter.rows[0].id]
        );
        return { tenant_id, deviceId: device.rows[0].id };
      });
    });

    if (!result) return reply.code(401).send({ error: "invalid_invite" });
    return reply.code(201).send({ device_id: result.deviceId });
  });

  app.post("/auth/technician/login", LOGIN_RATE_LIMIT, async (req, reply) => {
    const body = TechnicianLoginRequest.parse(req.body);

    const device = await withMigrator(async (db) => {
      const r = await db.query<{
        id: string; tenant_id: string; user_id: string; pin_hash: string; revoked_at: string | null;
      }>(
        `select id, tenant_id, user_id, pin_hash, revoked_at from technician_device where id = $1;`,
        [body.deviceId]
      );
      return r.rows[0];
    });

    if (!device || device.revoked_at) {
      return reply.code(401).send({ error: "invalid_device" });
    }
    const ok = await bcrypt.compare(body.pin, device.pin_hash);
    if (!ok) {
      return reply.code(401).send({ error: "invalid_pin" });
    }

    await withMigrator((db) =>
      db.query(`update technician_device set last_seen_at = now() where id = $1;`, [device.id])
    );

    const token = signTechnicianSession({
      tenant_id: device.tenant_id,
      user_id: device.user_id,
      role: "technician",
      device_id: device.id,
    });
    // Long-lived — field use, not re-login per job (architecture §2).
    reply.setCookie("fr_session", token, { ...COOKIE_OPTS, maxAge: 60 * 60 * 24 * 90 });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { device_id: string } }>(
    "/auth/technician/revoke/:device_id",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (req.auth!.role === "technician") {
        return reply.code(403).send({ error: "office_only" });
      }
      await withTenant(req.auth!.tenant_id, (tx) =>
        tx.query(`update technician_device set revoked_at = now() where id = $1 and tenant_id = $2;`, [
          req.params.device_id,
          req.auth!.tenant_id,
        ])
      );
      return reply.send({ ok: true });
    }
  );
}
