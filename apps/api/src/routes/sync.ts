// 04-API-SPEC.md §9 / architecture §4 (Option B). This is the endpoint
// Phase 1 exists to prove: a mutation queued offline, submitted (possibly
// more than once, if the app was killed mid-sync and retries the same
// batch on restart) applies exactly once, keyed on client_mutation_id.
//
// 05-phase2-job-loop.md §9 turns the Phase 1 single-mutation switch into the
// real set: execution_step.complete, test_result.record, closeout.submit,
// van_audit.record, on top of the original checklist_item.update. Each new
// branch calls the SAME domain function the equivalent direct HTTP route
// calls (apps/api/src/domain/*.ts) -- two independent implementations of
// "insert a test result" (etc.) would drift, which is exactly what routing
// both the office web UI and the offline phone through one function
// prevents. checklist_item.update is left as a direct inline query, same as
// Phase 1, since it has no HTTP-route equivalent to share with (the office
// UI uses PATCH /jobs/:id/checklist/:item_id, a different write shape --
// single column, no snapshot logic -- not worth extracting a one-line
// function for).
//
// Idempotency pattern (unchanged from Phase 1, CLAUDE.md non-negotiable):
// look up applied_mutation by (client_mutation_id, tenant_id) first; if
// found, return its stored result with status 'already_applied' and do
// nothing else; if not found, apply, then insert into applied_mutation with
// the result.

import type { FastifyInstance } from "fastify";
import { SyncMutationsRequest, type SyncMutation, type SyncMutationResult } from "@fieldready/core";
import { withTenant, type PGliteTx } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { completeExecutionStep } from "../domain/execution-steps.js";
import { recordTestResult } from "../domain/test-results.js";
import { submitCloseout } from "../domain/closeout.js";
import { recordVanAudit } from "../domain/van-audit.js";

async function applyMutation(
  tx: PGliteTx,
  tenantId: string,
  userId: string,
  m: SyncMutation
): Promise<SyncMutationResult> {
  switch (m.type) {
    case "checklist_item.update": {
      const updated = await tx.query<{ id: string }>(
        `update job_checklist_item
         set status = $1
         where id = $2 and tenant_id = $3 and job_id = $4
         returning id;`,
        [m.payload.status, m.payload.item_id, tenantId, m.job_id]
      );
      return updated.rows.length > 0
        ? { client_mutation_id: m.client_mutation_id, status: "applied" }
        : { client_mutation_id: m.client_mutation_id, status: "rejected", reason: "item_not_found" };
    }

    case "execution_step.complete": {
      const result = await completeExecutionStep(tx, tenantId, m.job_id, userId, m.payload.step);
      return result.kind === "ok"
        ? { client_mutation_id: m.client_mutation_id, status: "applied" }
        : { client_mutation_id: m.client_mutation_id, status: "rejected", reason: "job_not_found" };
    }

    case "test_result.record": {
      const result = await recordTestResult(tx, tenantId, m.job_id, userId, m.payload);
      return result.kind === "ok"
        ? { client_mutation_id: m.client_mutation_id, status: "applied" }
        : { client_mutation_id: m.client_mutation_id, status: "rejected", reason: "job_not_found" };
    }

    case "closeout.submit": {
      const result = await submitCloseout(tx, tenantId, m.job_id, userId, m.payload);
      return result.kind === "ok"
        ? { client_mutation_id: m.client_mutation_id, status: "applied" }
        : { client_mutation_id: m.client_mutation_id, status: "rejected", reason: "job_not_found" };
    }

    case "van_audit.record": {
      // van_audit isn't job-scoped (03-schema.sql §7 has no job_id column on
      // it) -- m.job_id identifies the job the technician was on at audit
      // time only for envelope-shape uniformity (packages/core/src/sync.ts's
      // own comment), it isn't written anywhere here.
      await recordVanAudit(tx, tenantId, userId, m.payload);
      return { client_mutation_id: m.client_mutation_id, status: "applied" };
    }
  }
}

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/sync/mutations", async (req, reply) => {
    const { mutations } = SyncMutationsRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const userId = req.auth!.user_id;

    const results: SyncMutationResult[] = await withTenant(tenantId, async (tx) => {
      // applied_mutation is a real, RLS-covered table (03-schema.sql §11a) —
      // fieldready_app has exactly select/insert/update/delete on it, not
      // CREATE, so it's provisioned by the schema/migration, never lazily
      // here.
      const out: SyncMutationResult[] = [];
      for (const m of mutations) {
        const already = await tx.query<{ result: SyncMutationResult }>(
          `select result from applied_mutation where client_mutation_id = $1 and tenant_id = $2;`,
          [m.client_mutation_id, tenantId]
        );
        if (already.rows[0]) {
          out.push({ ...already.rows[0].result, status: "already_applied" });
          continue;
        }

        const result = await applyMutation(tx, tenantId, userId, m);

        await tx.query(
          `insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
           values ($1, $2, $3, $4);`,
          [m.client_mutation_id, tenantId, m.type, JSON.stringify(result)]
        );
        out.push(result);
      }
      return out;
    });

    return reply.send({ results });
  });

  // Download direction (API spec §9) — 05-phase2-job-loop.md §9: everything
  // the device needs to operate fully offline from a cold start. Scoped to
  // the authenticated technician's own assigned_to jobs, per architecture §4
  // (a phone only ever needs its own worklist, not the whole tenant's).
  app.get("/sync/bootstrap", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const userId = req.auth!.user_id;

    const data = await withTenant(tenantId, async (tx) => {
      const jobRows = await tx.query<{
        id: string;
        readiness_snapshot: unknown;
        execution_snapshot: unknown;
        test_protocol_snapshot: unknown;
      }>(
        `select id, readiness_snapshot, execution_snapshot, test_protocol_snapshot
         from job
         where assigned_to = $1 and status in ('dispatched', 'in_progress', 'testing')
         order by created_at desc;`,
        [userId]
      );

      const jobs = [];
      for (const job of jobRows.rows) {
        const items = await tx.query<{ id: string; status: string }>(
          `select id, status from job_checklist_item where job_id = $1;`,
          [job.id]
        );
        jobs.push({ ...job, checklist_items: items.rows });
      }

      const vanAuditRows = await tx.query(
        `select id, van_label, performed_by, performed_at, next_due_at, issues
         from van_audit
         order by performed_at desc
         limit 1;`
      );

      // Equipment linkage: TestProtocolTest's formal Zod shape
      // (packages/core/src/template.ts) has no instrument_id field --
      // dispatch-gate.ts reads one defensively/optionally, but nothing in
      // the resolved snapshot schema guarantees it's ever populated, so
      // there's no clean way to filter equipment down to "referenced by
      // these jobs' test_protocol_snapshots" from the snapshot shape alone.
      // Per this task's own fallback instruction, return all of the
      // tenant's equipment rows instead of silently returning none --
      // flagged as a deviation.
      const equipmentRows = await tx.query(
        `select id, tenant_id, kind, make, model, serial, calibration_expires_on
         from equipment
         order by created_at desc;`
      );

      return {
        jobs,
        van_audits: vanAuditRows.rows,
        equipment: equipmentRows.rows,
      };
    });

    return reply.send({ cursor: new Date().toISOString(), ...data });
  });
}
