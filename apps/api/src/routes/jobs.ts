// 04-API-SPEC.md §5, 03-schema.sql §7, 05-phase2-job-loop.md §5. Same
// route-file pattern as templates.ts/quotes.ts: requireAuth preHandler,
// withTenant for every query, parameterized SQL only.
//
// PATCH /jobs/:id/checklist/:item_id is the office-side direct write only
// -- the phone goes through POST /sync/mutations instead (§5: "a direct
// PATCH assumes connectivity the phone doesn't have"). CLAUDE.md
// non-negotiable: no "confirm all" shortcut anywhere in this file --
// status is set one item at a time, by id.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  JobPatchRequest,
  JobChecklistItemUpdateRequest,
  JobPhotoUploadMetadata,
  JobTestResultRecordRequest,
  JobCloseoutTechnicianRequest,
  JobCloseoutReworkCauseRequest,
} from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { evaluateDispatchGate } from "../domain/dispatch-gate.js";
import { objectStore } from "../object-store.js";
import { completeExecutionStep } from "../domain/execution-steps.js";
import { recordTestResult } from "../domain/test-results.js";
import { submitCloseout } from "../domain/closeout.js";
import { insertTermoDeadline } from "../domain/deadlines.js";

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { status?: string; assigned_to?: string } }>("/jobs", async (req, reply) => {
    const { status, assigned_to } = req.query;
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, quote_id, client_id, code, title, address, job_type,
                scheduled_at, quoted_hours, quoted_materials, actual_hours, actual_materials,
                assigned_to, status, ited_classification, ited_classification_note,
                ited_classification_by, completed_at, created_at
         from job
         where ($1::text is null or status = $1) and ($2::uuid is null or assigned_to = $2)
         order by created_at desc;`,
        [status ?? null, assigned_to ?? null]
      )
    );
    return reply.send({ jobs: rows.rows });
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(`select * from job where id = $1;`, [req.params.id])
    );
    if (rows.rows.length === 0) return reply.code(404).send({ error: "job_not_found" });
    return reply.send(rows.rows[0]);
  });

  // Office edits: schedule, assignment, ited_classification. PRD §7 / the
  // job.ts schema's own .refine already reject out_of_scope/exempt without
  // a note before this ever reaches SQL; the check below is the other half
  // of "the technician never classifies anything" -- a role check, because
  // ited_classification is office-review-only, not something the phone
  // route accepts at all in this design (unlike job_closeout.rework_cause,
  // which is kept off the technician schema entirely -- there IS one shared
  // job.ts schema for office edits, since technicians have no PATCH /jobs
  // client at all in this phase, so a role check here is the enforcement
  // point).
  app.patch<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const body = JobPatchRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    if (body.ited_classification !== undefined && req.auth!.role === "technician") {
      return reply.code(403).send({
        error: "technician_cannot_classify",
        message: "ited_classification is office-review-only (PRD §7).",
      });
    }

    const result = await withTenant(tenantId, async (tx) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;

      if (body.scheduled_at !== undefined) {
        sets.push(`scheduled_at = $${i++}`);
        values.push(body.scheduled_at);
      }
      if (body.assigned_to !== undefined) {
        sets.push(`assigned_to = $${i++}`);
        values.push(body.assigned_to);
      }
      if (body.ited_classification !== undefined) {
        sets.push(`ited_classification = $${i++}`);
        values.push(body.ited_classification);
        sets.push(`ited_classification_note = $${i++}`);
        values.push(body.ited_classification_note ?? null);
        // Office-review-only (PRD §7) -- stamped from the verified session,
        // never client-supplied.
        sets.push(`ited_classification_by = $${i++}`);
        values.push(req.auth!.user_id);
      }

      if (sets.length === 0) {
        const current = await tx.query(`select * from job where id = $1;`, [req.params.id]);
        return current.rows[0] ? { kind: "ok" as const, row: current.rows[0] } : { kind: "not_found" as const };
      }

      values.push(req.params.id);
      const updated = await tx.query(
        `update job set ${sets.join(", ")} where id = $${i} returning *;`,
        values
      );
      return updated.rows[0]
        ? { kind: "ok" as const, row: updated.rows[0] }
        : { kind: "not_found" as const };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.send(result.row);
  });

  // Thin: v_job_readiness (schema §13) + per-item detail. Retires the
  // Phase-1 debug endpoint sync.ts used to stand in for this (§1/§5).
  app.get<{ Params: { id: string } }>("/jobs/:id/readiness", async (req, reply) => {
    const result = await withTenant(req.auth!.tenant_id, async (tx) => {
      const summary = await tx.query(
        `select job_id, tenant_id, mandatory_total, mandatory_ok, readiness_pct
         from v_job_readiness where job_id = $1;`,
        [req.params.id]
      );
      if (summary.rows.length === 0) return { kind: "not_found" as const };

      const items = await tx.query(
        `select id, cat, label, qty, item_id, scope, mandatory, status, updated_by, updated_at
         from job_checklist_item
         where job_id = $1
         order by scope, cat, label;`,
        [req.params.id]
      );
      return { kind: "ok" as const, summary: summary.rows[0], items: items.rows };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.send({ ...result.summary, items: result.items });
  });

  // Office-side direct write, NOT for phone use (§5) -- the phone submits
  // checklist_item.update mutations through POST /sync/mutations instead,
  // since it's offline-first by construction (architecture §4).
  app.patch<{ Params: { id: string; item_id: string } }>(
    "/jobs/:id/checklist/:item_id",
    async (req, reply) => {
      const body = JobChecklistItemUpdateRequest.parse(req.body);
      const tenantId = req.auth!.tenant_id;

      const updated = await withTenant(tenantId, (tx) =>
        tx.query<{ id: string; status: string }>(
          `update job_checklist_item
           set status = $1, updated_by = $2, updated_at = now()
           where id = $3 and job_id = $4
           returning id, status;`,
          [body.status, req.auth!.user_id, req.params.item_id, req.params.id]
        )
      );

      if (updated.rows.length === 0) return reply.code(404).send({ error: "checklist_item_not_found" });
      return reply.send(updated.rows[0]);
    }
  );

  // THE GATE (04-API-SPEC.md §5, 05-phase2-job-loop.md §6a). The four
  // conditions live in domain/dispatch-gate.ts so they're unit-testable
  // independent of HTTP; this route only maps {ok:true}/{ok:false} to
  // 200/409 and, on success, flips job.status and echoes back the
  // snapshots already frozen at job-creation time -- dispatch never
  // re-resolves templates (architecture §5's "resolved once" rule).
  app.post<{ Params: { id: string } }>("/jobs/:id/dispatch", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const jobRows = await tx.query<{
        id: string;
        status: string;
        readiness_snapshot: unknown;
        execution_snapshot: unknown;
        test_protocol_snapshot: unknown;
      }>(
        `select id, status, readiness_snapshot, execution_snapshot, test_protocol_snapshot
         from job where id = $1;`,
        [jobId]
      );
      if (jobRows.rows.length === 0) return { kind: "not_found" as const };
      const job = jobRows.rows[0];

      // Status precondition (review finding, medium): dispatch only ever
      // makes sense from 'ready_check' -- the state job-creation.ts leaves a
      // freshly-created job in and the only state nothing downstream has
      // touched yet. Without this, a job that's already progressed past
      // dispatch (and whose stale checklist/van-audit/classification data
      // still happens to satisfy evaluateDispatchGate -- close-out doesn't
      // reset any of that, see domain/closeout.ts) could be re-dispatched,
      // silently reverting status = 'closed'/'cancelled'/etc back to
      // 'dispatched' with no error and no audit trail. Mirrors the
      // `eligibleStatuses` guard POST /jobs/:id/complete already uses above.
      if (job.status !== "ready_check") {
        return { kind: "wrong_status" as const, status: job.status };
      }

      const gate = await evaluateDispatchGate(tx, tenantId, jobId);
      if (!gate.ok) return { kind: "not_ready" as const, blocking: gate.blocking };

      const updated = await tx.query<{
        readiness_snapshot: unknown;
        execution_snapshot: unknown;
        test_protocol_snapshot: unknown;
      }>(
        `update job set status = 'dispatched'
         where id = $1 and tenant_id = $2
         returning readiness_snapshot, execution_snapshot, test_protocol_snapshot;`,
        [jobId, tenantId]
      );

      return { kind: "ok" as const, row: updated.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    if (result.kind === "wrong_status")
      return reply.code(409).send({ error: "wrong_status", status: result.status });
    if (result.kind === "not_ready")
      return reply.code(409).send({ error: "not_ready", blocking: result.blocking });
    return reply.send({
      readiness_snapshot: result.row.readiness_snapshot,
      execution_snapshot: result.row.execution_snapshot,
      test_protocol_snapshot: result.row.test_protocol_snapshot,
    });
  });

  // 05-phase2-job-loop.md §7. Marks one step of job.execution_snapshot.steps
  // complete. step_order isn't cross-checked against the snapshot's own
  // step list here -- the snapshot is advisory client-side rendering data
  // (architecture §5's "resolved once" rule means this route doesn't
  // re-read the template either), and job_execution_step_completion's own
  // unique(job_id, step_order) is what actually matters for idempotency:
  // completing the same step twice (e.g. a retried request) updates the
  // same row rather than erroring or duplicating.
  app.post<{ Params: { id: string; step: string } }>(
    "/jobs/:id/execution-steps/:step/complete",
    async (req, reply) => {
      const stepOrder = Number(req.params.step);
      if (!Number.isInteger(stepOrder) || stepOrder < 0) {
        return reply.code(400).send({ error: "invalid_step", message: "step must be a non-negative integer." });
      }

      const tenantId = req.auth!.tenant_id;
      const jobId = req.params.id;

      const result = await withTenant(tenantId, (tx) =>
        completeExecutionStep(tx, tenantId, jobId, req.auth!.user_id, stepOrder)
      );

      if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
      return reply.send(result.row);
    }
  );

  // Multipart upload (04-API-SPEC.md §5, 05-phase2-job-loop.md §7): binary
  // bytes travel as a separate part, never through the JSON sync envelope.
  // Fields (phase, required_tag) are validated the same way every other
  // route validates its body -- via the Zod schema -- just read off
  // data.fields instead of req.body, since @fastify/multipart's promise API
  // (req.file()) is what parses them, not the JSON body parser.
  app.post<{ Params: { id: string } }>("/jobs/:id/photos", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: "no_file", message: "Expected a multipart file part." });
    }

    const fieldValue = (name: string): unknown => {
      const field = data.fields[name];
      if (!field || Array.isArray(field) || field.type !== "field") return undefined;
      return field.value;
    };

    const metadata = JobPhotoUploadMetadata.parse({
      phase: fieldValue("phase"),
      required_tag: fieldValue("required_tag") ?? undefined,
    });

    const buffer = await data.toBuffer();
    const key = crypto.randomUUID();
    await objectStore.put(key, buffer);

    const result = await withTenant(tenantId, async (tx) => {
      const jobRows = await tx.query(`select id from job where id = $1;`, [jobId]);
      if (jobRows.rows.length === 0) return { kind: "not_found" as const };

      const inserted = await tx.query(
        `insert into job_photo (tenant_id, job_id, phase, required_tag, file, taken_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id, job_id, phase, required_tag, file, taken_at, taken_by;`,
        [tenantId, jobId, metadata.phase, metadata.required_tag ?? null, key, req.auth!.user_id]
      );
      return { kind: "ok" as const, row: inserted.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.send(result.row);
  });

  // 05-phase2-job-loop.md §7 / §9: the actual validate+write logic (outcome
  // computed server-side via evalTest against the job's frozen
  // test_protocol_snapshot) lives in domain/test-results.ts's
  // recordTestResult, shared with the test_result.record sync mutation
  // handler (sync.ts) so the two entry points can't drift.
  app.post<{ Params: { id: string } }>("/jobs/:id/test-results", async (req, reply) => {
    const body = JobTestResultRecordRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const result = await withTenant(tenantId, (tx) =>
      recordTestResult(tx, tenantId, jobId, req.auth!.user_id, body)
    );

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.send(result.row);
  });

  // 05-phase2-job-loop.md §8: this is also the moment compliance_deadline
  // rows are created for ited_ready/ited_full tenants
  // (06-phase3-compliance.md §6) -- the termo 10-working-day clock starts
  // the moment completed_at is first set, and for the office two-step flow
  // (complete, then closeout) this route is that moment, not
  // domain/closeout.ts's submitCloseout (which only inserts the deadline
  // itself when *it* is the call that first sets completed_at -- the phone
  // flow's case, where there is no separate /complete tap). Status lands on
  // 'testing', not 'closed': 03-schema.sql §7's job.status enum treats
  // close-out (POST /jobs/:id/closeout) as the actual terminal transition,
  // so this route only marks "execution work is done, AAR/test capture is
  // what's left" -- an intermediate state, not the end of the loop.
  app.post<{ Params: { id: string } }>("/jobs/:id/complete", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const jobRows = await tx.query<{ id: string; status: string; completed_at: string | null }>(
        `select id, status, completed_at from job where id = $1;`,
        [jobId]
      );
      if (jobRows.rows.length === 0) return { kind: "not_found" as const };
      const job = jobRows.rows[0];

      const eligibleStatuses = ["dispatched", "in_progress", "testing"];
      if (job.completed_at !== null || !eligibleStatuses.includes(job.status)) {
        return { kind: "conflict" as const, status: job.status, completed_at: job.completed_at };
      }

      const updated = await tx.query<{ id: string; status: string; completed_at: string }>(
        `update job set completed_at = now(), status = 'testing'
         where id = $1 and tenant_id = $2
         returning id, status, completed_at;`,
        [jobId, tenantId]
      );

      const tenantRows = await tx.query<{ compliance_profile: string }>(
        `select compliance_profile from tenant where id = $1;`,
        [tenantId]
      );
      const complianceProfile = tenantRows.rows[0]?.compliance_profile ?? "basic";
      if (complianceProfile !== "basic") {
        await insertTermoDeadline(tx, tenantId, jobId, new Date(updated.rows[0].completed_at));
      }

      return { kind: "ok" as const, row: updated.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    if (result.kind === "conflict") {
      return reply.code(409).send({
        error: "already_completed_or_invalid_status",
        status: result.status,
        completed_at: result.completed_at,
      });
    }
    return reply.send(result.row);
  });

  // 05-phase2-job-loop.md §8 — technician-facing close-out (F19).
  // JobCloseoutTechnicianRequest (packages/core/src/closeout.ts) has no
  // rework_cause field at all, so there is no way for this route to accept
  // or expose it -- office-only assignment happens on the separate route
  // below, against a separate schema.
  app.post<{ Params: { id: string } }>("/jobs/:id/closeout", async (req, reply) => {
    const body = JobCloseoutTechnicianRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const result = await withTenant(tenantId, (tx) =>
      submitCloseout(tx, tenantId, jobId, req.auth!.user_id, body)
    );

    if (result.kind === "not_found") return reply.code(404).send({ error: "job_not_found" });
    return reply.send(result.row);
  });

  // Office-only (PRD §6, CLAUDE.md): rework_cause is office-assigned
  // taxonomy, never technician-set. Enforced by a role check here AND by
  // JobCloseoutTechnicianRequest never defining the field in the first
  // place (belt-and-suspenders, per closeout.ts's own comment) -- this
  // route requires a job_closeout row to already exist (created by
  // POST /jobs/:id/closeout above) since rework_cause lives on that table.
  app.patch<{ Params: { id: string } }>("/jobs/:id/closeout/rework-cause", async (req, reply) => {
    if (req.auth!.role === "technician") {
      return reply.code(403).send({
        error: "technician_cannot_set_rework_cause",
        message: "rework_cause is office-only (PRD §6).",
      });
    }

    const body = JobCloseoutReworkCauseRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const updated = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string; rework_cause: string; rework_cause_set_by: string }>(
        `update job_closeout
         set rework_cause = $1, rework_cause_set_by = $2
         where job_id = $3 and tenant_id = $4
         returning id, rework_cause, rework_cause_set_by;`,
        [body.rework_cause, req.auth!.user_id, jobId, tenantId]
      )
    );

    if (updated.rows.length === 0) return reply.code(404).send({ error: "job_closeout_not_found" });
    return reply.send(updated.rows[0]);
  });
}
