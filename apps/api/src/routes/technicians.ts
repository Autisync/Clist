// Technician device pairing/revocation — the Admin-API half of the
// technician-auth migration (08-supabase-native-migration.md §2).
// Deliberately a Fastify route, not an RPC: creating a Supabase Auth user
// (pairing) and banning one (revoking) both require the service_role Admin
// API, which no plpgsql function can reach — the same reasoning that ruled
// out rpc_technician_device_pair earlier in this migration (see
// apps/api/README.md's Supabase-native section for that history).
// rpc_technician_create (rpc.sql) is the plain-RLS half that creates the
// technician's app_user row this route's :technician_app_user_id param
// points at.
//
// Auth: requireAuth (auth/middleware.ts) — accepts either the classic
// fr_session cookie or a real Supabase bearer token (auth/supabase-
// bridge.ts) equally, so a real office user with only a Supabase session
// can reach this like any other still-Fastify route.
//
// Identity resolution here queries public.app_user/public.technician_device
// directly via withPublicSchema (db.ts) — the same trusted, RLS-bypassing
// connection auth/supabase-bridge.ts's withMigrator calls use, but with the
// session's search_path pinned to `public` for the duration, not the
// classic system's fastify_api. Required, not just tidy: db.ts's own
// comment on withPublicSchema has the real bug this fixes — schema-
// qualifying the target table (public.technician_device) is not enough
// when a trigger on it makes its own UNQUALIFIED reference to app_user;
// that reference resolves via this connection's search_path regardless of
// how the outer query was written, and this pool's search_path is
// fastify_api by default (found the hard way, not anticipated).

import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { withPublicSchema } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

const DEVICE_EMAIL_DOMAIN = "device.fieldready.internal";

function authApiBase(): string {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!projectRef) {
    throw new Error("SUPABASE_PROJECT_REF must be set for technician device pairing/revocation.");
  }
  return `https://${projectRef}.supabase.co/auth/v1`;
}

function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for technician device pairing/revocation.");
  }
  return key;
}

async function createDeviceAuthUser(deviceId: string, pin: string): Promise<string> {
  const res = await fetch(`${authApiBase()}/admin/users`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: serviceRoleKey(),
      authorization: `Bearer ${serviceRoleKey()}`,
    },
    body: JSON.stringify({
      email: `${deviceId}@${DEVICE_EMAIL_DOMAIN}`,
      password: pin,
      email_confirm: true, // no real email is ever sent — synthetic identity
    }),
  });
  const body = (await res.json()) as { id?: string; msg?: string; error_code?: string };
  if (!res.ok || !body.id) {
    // Most likely real-world cause: Supabase's project-level minimum
    // password length rejecting a bare 4-digit PIN (08-supabase-native-
    // migration.md §2's own flagged "real friction to resolve" — lower it
    // in the Supabase dashboard, Authentication -> Policies). Surfaced as
    // its own error code so that's diagnosable from the response, not a
    // generic 500.
    const tooShort = body.error_code === "weak_password" || /password/i.test(body.msg ?? "");
    throw Object.assign(new Error(body.msg ?? "Supabase Admin API createUser failed"), {
      code: tooShort ? "pin_rejected_by_supabase_password_policy" : "admin_api_error",
    });
  }
  return body.id;
}

// Best-effort only — see routes/technicians.ts's revoke handler comment for
// why this can't be a guaranteed "kill the live session right now" the way
// 08-supabase-native-migration.md §2 originally sketched (admin.signOut
// needs the device's own live JWT, which this server never holds). Banning
// prevents any FUTURE sign-in/refresh; the already-proven revoked_at
// re-check (auth/supabase-bridge.ts, fn_current_tenant_id()) is what
// actually closes the "still has an unexpired access token" window, and it
// does that unconditionally — this call failing must never block the
// revoke itself.
async function banDeviceAuthUser(authUserId: string): Promise<void> {
  await fetch(`${authApiBase()}/admin/users/${authUserId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      apikey: serviceRoleKey(),
      authorization: `Bearer ${serviceRoleKey()}`,
    },
    // GoTrue has no literal "forever" — "876000h" (100 years) is its own
    // documented idiom for a permanent ban, confirmed against the real
    // Admin API before relying on it (a fresh test user's sign-in went
    // from 200 to 400 user_banned immediately after this exact call).
    body: JSON.stringify({ ban_duration: "876000h" }),
  }).catch(() => {
    // Deliberately swallowed — see comment above.
  });
}

// Moderate, not strict — these two routes are already requireAuth-gated
// (not anonymous-brute-forceable the way routes/auth.ts's login endpoints
// are), but each call hits the real Supabase Admin API to create or ban a
// real Auth user, so it's still worth bounding a compromised/leaked
// session or a runaway client bug from mass-provisioning or mass-banning
// devices. A real office pairs at most a handful of devices per minute.
const ADMIN_API_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

export async function technicianRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{ Params: { technician_app_user_id: string }; Body: { device_label?: string; pin?: string } }>(
    "/technicians/:technician_app_user_id/pair",
    ADMIN_API_RATE_LIMIT,
    async (req, reply) => {
      if (req.auth!.role === "technician") {
        return reply.code(403).send({ error: "office_only", message: "Pairing a device is office-only." });
      }

      const deviceLabel = req.body?.device_label?.trim();
      const pin = req.body?.pin;
      if (!deviceLabel) {
        return reply.code(400).send({ error: "invalid_body", message: "device_label is required." });
      }
      if (!pin || !/^\d{4}$/.test(pin)) {
        return reply.code(400).send({ error: "invalid_body", message: "pin must be exactly 4 digits." });
      }

      const technicianId = req.params.technician_app_user_id;
      const tenantId = req.auth!.tenant_id;

      const technician = await withPublicSchema((db) =>
        db.query<{ id: string }>(
          `select id from public.app_user where id = $1 and tenant_id = $2 and role = 'technician';`,
          [technicianId, tenantId]
        )
      );
      if (technician.rows.length === 0) {
        return reply.code(404).send({ error: "technician_not_found" });
      }

      const deviceId = crypto.randomUUID();
      let authUserId: string;
      try {
        authUserId = await createDeviceAuthUser(deviceId, pin);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "pin_rejected_by_supabase_password_policy") {
          return reply.code(422).send({
            error: "pin_rejected_by_supabase_password_policy",
            message:
              "Supabase's minimum password length is rejecting this PIN — lower it to 4 in " +
              "the Supabase dashboard (Authentication -> Policies) and try again.",
          });
        }
        req.log.error({ err }, "technician device pairing: Admin API createUser failed");
        return reply.code(502).send({ error: "pairing_failed" });
      }

      await withPublicSchema((db) =>
        db.query(
          `insert into public.technician_device (id, tenant_id, user_id, device_label, auth_user_id, paired_by)
           values ($1, $2, $3, $4, $5, $6);`,
          [deviceId, tenantId, technicianId, deviceLabel, authUserId, req.auth!.user_id]
        )
      );

      return reply.code(201).send({ device_id: deviceId });
    }
  );

  app.post<{ Params: { device_id: string } }>(
    "/technicians/devices/:device_id/revoke",
    ADMIN_API_RATE_LIMIT,
    async (req, reply) => {
      if (req.auth!.role === "technician") {
        return reply.code(403).send({ error: "office_only", message: "Revoking a device is office-only." });
      }

      const device = await withPublicSchema((db) =>
        db.query<{ auth_user_id: string }>(
          `update public.technician_device
           set revoked_at = now()
           where id = $1 and tenant_id = $2 and revoked_at is null
           returning auth_user_id;`,
          [req.params.device_id, req.auth!.tenant_id]
        )
      );
      if (device.rows.length === 0) {
        // Either it doesn't exist, belongs to a different tenant (RLS-shaped
        // "not found", not a leak, same convention every RPC in this codebase
        // uses), or was already revoked — idempotent either way, not an error.
        return reply.send({ ok: true, already_revoked_or_not_found: true });
      }

      await banDeviceAuthUser(device.rows[0].auth_user_id);
      return reply.send({ ok: true });
    }
  );
}
