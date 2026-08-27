// Platform-admin-only routes — tenant onboarding, the UI replacement for
// running apps/api/supabase/provision-tenant.mjs by hand. Ports that
// script's exact sequence (unique-slug check, tenant insert, Admin API
// createUser with rollback-on-failure, app_user insert) rather than
// reinventing it — same reasoning routes/technicians.ts's own pairing
// endpoint already established for this class of route: creating a real
// Supabase Auth user needs the service_role Admin API, unreachable from a
// plpgsql RPC, so this has to be a Fastify route.
//
// Auth: requirePlatformAdmin (auth/platform-admin-middleware.ts) — a
// separate, narrower gate from requireAuth/SessionClaims, because a
// platform admin has no tenant_id at all to fit that shape.
//
// Reading the tenant list needs no route here — schema.sql §2b's
// platform_admin_read_all_tenants RLS policy already lets a real platform
// admin session read every tenant row via a plain `.from("tenant")` call
// straight from the browser.

import type { FastifyInstance } from "fastify";
import { withPublicSchema } from "../db.js";
import { requirePlatformAdmin } from "../auth/platform-admin-middleware.js";

const COMPLIANCE_PROFILES = ["basic", "ited_ready", "ited_full"] as const;

function authApiBase(): string {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  if (!projectRef) throw new Error("SUPABASE_PROJECT_REF must be set for tenant onboarding.");
  return `https://${projectRef}.supabase.co/auth/v1`;
}

function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY must be set for tenant onboarding.");
  return key;
}

// Same "requirePlatformAdmin-gated but still hits the real Supabase Admin
// API" reasoning as routes/technicians.ts's ADMIN_API_RATE_LIMIT — bounds
// a compromised admin session or a runaway client from mass-provisioning
// tenants, without meaningfully limiting real onboarding pace.
const ADMIN_API_RATE_LIMIT = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

export async function platformAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requirePlatformAdmin);

  app.post<{
    Body: {
      tenant_name?: string;
      tenant_slug?: string;
      compliance_profile?: string;
      office_name?: string;
      office_email?: string;
      office_password?: string;
    };
  }>("/platform-admin/tenants", ADMIN_API_RATE_LIMIT, async (req, reply) => {
    const body = req.body ?? {};
    const tenantName = body.tenant_name?.trim();
    const tenantSlug = body.tenant_slug?.trim();
    const complianceProfile = body.compliance_profile ?? "ited_ready";
    const officeName = body.office_name?.trim();
    const officeEmail = body.office_email?.trim();
    const officePassword = body.office_password;

    if (!tenantName || !tenantSlug || !officeName || !officeEmail || !officePassword) {
      return reply.code(400).send({
        error: "invalid_body",
        message: "tenant_name, tenant_slug, office_name, office_email, and office_password are all required.",
      });
    }
    if (!COMPLIANCE_PROFILES.includes(complianceProfile as (typeof COMPLIANCE_PROFILES)[number])) {
      return reply.code(400).send({
        error: "invalid_body",
        message: `compliance_profile must be one of ${COMPLIANCE_PROFILES.join(", ")}.`,
      });
    }

    // Same schema-qualified, search_path-safe connection routes/
    // technicians.ts's pairing endpoint uses, for the same reason
    // (db.ts's own comment on withPublicSchema — the classic system's
    // connection pool defaults to a different search_path).
    const existing = await withPublicSchema((db) =>
      db.query<{ id: string }>(`select id from public.tenant where slug = $1;`, [tenantSlug])
    );
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: "slug_taken", message: `A tenant with slug "${tenantSlug}" already exists.` });
    }

    const tenant = await withPublicSchema((db) =>
      db.query<{ id: string }>(
        `insert into public.tenant (name, slug, compliance_profile) values ($1, $2, $3) returning id;`,
        [tenantName, tenantSlug, complianceProfile]
      )
    );
    const tenantId = tenant.rows[0].id;

    const authRes = await fetch(`${authApiBase()}/admin/users`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: serviceRoleKey(),
        authorization: `Bearer ${serviceRoleKey()}`,
      },
      body: JSON.stringify({ email: officeEmail, password: officePassword, email_confirm: true }),
    });
    const authBody = (await authRes.json()) as { id?: string; msg?: string; error_code?: string };
    if (!authRes.ok || !authBody.id) {
      // Rollback the tenant row — same as provision-tenant.mjs's own
      // "created the tenant, then the Auth user creation failed" path.
      await withPublicSchema((db) => db.query(`delete from public.tenant where id = $1;`, [tenantId]));
      const emailTaken = authBody.error_code === "email_exists" || /already.*registered/i.test(authBody.msg ?? "");
      req.log.error({ authBody }, "tenant onboarding: Admin API createUser failed");
      return reply.code(emailTaken ? 409 : 502).send({
        error: emailTaken ? "office_email_taken" : "onboarding_failed",
        message: emailTaken
          ? `${officeEmail} is already a Supabase Auth user (an office user of another tenant, or a platform admin).`
          : "Failed to create the office user's account.",
      });
    }
    const officeAuthUserId = authBody.id;

    const officeUser = await withPublicSchema((db) =>
      db.query<{ id: string }>(
        `insert into public.app_user (auth_user_id, tenant_id, role, full_name, email)
         values ($1, $2, 'owner', $3, $4) returning id;`,
        [officeAuthUserId, tenantId, officeName, officeEmail]
      )
    );

    return reply.code(201).send({ tenant_id: tenantId, office_user_id: officeUser.rows[0].id });
  });
}
