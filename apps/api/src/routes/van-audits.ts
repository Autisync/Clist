// 05-phase2-job-loop.md §5a — closing a real gap in 04-API-SPEC.md: the spec
// documents the dispatch-gate check that READS a van_audit (§5, condition 2)
// but never lists an endpoint to CREATE one. Same route-file pattern as
// templates.ts/quotes.ts: requireAuth preHandler, withTenant for every
// query, parameterized SQL only.

import type { FastifyInstance } from "fastify";
import { CreateVanAuditRequest } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { recordVanAudit } from "../domain/van-audit.js";

export async function vanAuditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/van-audits", async (req, reply) => {
    const body = CreateVanAuditRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, (tx) => recordVanAudit(tx, tenantId, req.auth!.user_id, body));

    return reply.code(201).send(created);
  });

  app.get<{ Querystring: { van_label?: string } }>("/van-audits/latest", async (req, reply) => {
    const { van_label } = req.query;
    if (!van_label) {
      return reply.code(400).send({ error: "van_label_required" });
    }

    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, van_label, performed_by, performed_at, next_due_at, issues
         from van_audit
         where van_label = $1
         order by performed_at desc
         limit 1;`,
        [van_label]
      )
    );

    if (rows.rows.length === 0) return reply.code(404).send({ error: "van_audit_not_found" });
    return reply.send(rows.rows[0]);
  });
}
