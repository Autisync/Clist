// 05-phase2-job-loop.md §7 / §9. The core "validate + write" logic behind
// POST /jobs/:id/execution-steps/:step/complete, factored out so the direct
// HTTP route and the sync mutation handler (execution_step.complete,
// phone/offline) call the exact same code path. job_execution_step_completion
// (03-schema.sql §11b) already carries unique(job_id, step_order), which is
// what actually makes this idempotent -- completing the same step twice (a
// retried request, or a replayed sync batch) updates the same row rather
// than erroring or duplicating.

import type { PGliteTx } from "../db.js";

export type ExecutionStepCompletionRow = {
  step_order: number;
  completed_at: string;
  completed_by: string | null;
};

export type CompleteExecutionStepResult =
  | { kind: "ok"; row: ExecutionStepCompletionRow }
  | { kind: "not_found" };

export async function completeExecutionStep(
  tx: PGliteTx,
  tenantId: string,
  jobId: string,
  userId: string,
  stepOrder: number
): Promise<CompleteExecutionStepResult> {
  const jobRows = await tx.query(`select id from job where id = $1;`, [jobId]);
  if (jobRows.rows.length === 0) return { kind: "not_found" };

  const completion = await tx.query<ExecutionStepCompletionRow>(
    `insert into job_execution_step_completion (tenant_id, job_id, step_order, completed_by)
     values ($1, $2, $3, $4)
     on conflict (job_id, step_order)
     do update set completed_at = now(), completed_by = excluded.completed_by
     returning step_order, completed_at, completed_by;`,
    [tenantId, jobId, stepOrder, userId]
  );
  return { kind: "ok", row: completion.rows[0] };
}
