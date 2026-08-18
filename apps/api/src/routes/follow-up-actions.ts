// 05-phase2-job-loop.md §8, 03-schema.sql §11 (follow_up_action). Same
// route-file pattern as van-audits.ts/equipment.ts: requireAuth preHandler,
// withTenant for every query, parameterized SQL only. Simple tenant-scoped
// CRUD raised out of a job's close-out -- no gate, no snapshot logic.

import type { FastifyInstance } from "fastify";
import { CreateFollowUpActionRequest } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

export async function followUpActionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Params: { id: string } }>("/jobs/:id/follow-up-actions", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, job_id, description, owner, owner_user_id, due_on, status, created_at
         from follow_up_action
         where job_id = $1
         order by created_at desc;`,
        [req.params.id]
      )
    );
    return reply.send({ follow_up_actions: rows.rows });
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/follow-up-actions", async (req, reply) => {
    const body = CreateFollowUpActionRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const jobRows = await tx.query(`select id from job where id = $1;`, [jobId]);
      if (jobRows.rows.length === 0) return { kind: "not_found" as const };

      const inserted = await tx.query(
        `insert into follow_up_action (tenant_id, job_id, description, owner, owner_user_id, due_on)
         values ($1, $2, $3, $4, $5, $6)
         returning id, tenant_id, job_id, description, owner, owner_user_id, due_on, status, created_at;`,
        [tenantId, jobId, body.description, body.owner ?? null, body.owner_user_id ?? null, body.due_on ?? null]
      );
      return { kind: "ok" as const, row: inserted.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.code(201).send(result.row);
  });
}
