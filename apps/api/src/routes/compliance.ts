// F17 — statutory deadline polling. 06-phase3-compliance.md §6,
// 04-API-SPEC.md §7: `GET /compliance/deadlines?status=&due_before=`, the
// read endpoint a scheduled escalation worker (architecture §2,
// graphile-worker) polls to transition open -> reminder_sent ->
// warning_sent -> overdue. A simple filtered query against
// compliance_deadline -- no business logic here, same "thin read" spirit
// as the dashboard routes (04-API-SPEC.md §8).
//
// Only reachable for ited_ready/ited_full tenants (403 otherwise, same gate
// routes/ref.ts and routes/termo.ts already enforce).

import type { FastifyInstance } from "fastify";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

const COMPLIANCE_PROFILE_REQUIRED_ERROR = {
  error: "compliance_profile_basic",
  message: "Compliance deadlines require the tenant's compliance_profile to be ited_ready or ited_full (API spec §7).",
};

async function tenantComplianceProfile(
  tx: import("../db.js").PGliteTx,
  tenantId: string
): Promise<string> {
  const rows = await tx.query<{ compliance_profile: string }>(
    `select compliance_profile from tenant where id = $1;`,
    [tenantId]
  );
  return rows.rows[0]?.compliance_profile ?? "basic";
}

export async function complianceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string; due_before?: string } }>(
    "/compliance/deadlines",
    async (req, reply) => {
      const tenantId = req.auth!.tenant_id;
      const { status, due_before } = req.query;

      const outcome = await withTenant(tenantId, async (tx) => {
        if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
          return { kind: "forbidden" as const };
        }

        const conditions = [`tenant_id = $1`];
        const params: unknown[] = [tenantId];

        if (status) {
          params.push(status);
          conditions.push(`status = $${params.length}`);
        }
        if (due_before) {
          params.push(due_before);
          conditions.push(`due_on < $${params.length}`);
        }

        const rows = await tx.query(
          `select * from compliance_deadline where ${conditions.join(" and ")} order by due_on asc;`,
          params
        );
        return { kind: "ok" as const, rows: rows.rows };
      });

      if (outcome.kind === "forbidden") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);
      return reply.send(outcome.rows);
    }
  );
}
