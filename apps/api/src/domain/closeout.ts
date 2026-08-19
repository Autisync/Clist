// 05-phase2-job-loop.md §8 / §9. The core "validate + write" logic behind
// POST /jobs/:id/closeout (technician-facing), factored out so the direct
// HTTP route and the sync mutation handler (closeout.submit, phone/offline)
// call the exact same code path.
//
// Takes JobCloseoutTechnicianRequest specifically -- that type has no
// rework_cause field at all (packages/core/src/closeout.ts), so there is no
// way for this function, or anything that calls it, to write rework_cause.
// Office-side rework_cause assignment is a completely separate route
// (PATCH /jobs/:id/closeout/rework-cause) and a completely separate SQL
// statement in jobs.ts -- not a variant of this function.

import type { JobCloseoutTechnicianRequest } from "@fieldready/core";
import type { PGliteTx } from "../db.js";

export type SubmitCloseoutResult =
  | { kind: "ok"; row: Record<string, unknown> }
  | { kind: "not_found" };

export async function submitCloseout(
  tx: PGliteTx,
  tenantId: string,
  jobId: string,
  userId: string,
  body: JobCloseoutTechnicianRequest
): Promise<SubmitCloseoutResult> {
  const jobRows = await tx.query(`select id from job where id = $1;`, [jobId]);
  if (jobRows.rows.length === 0) return { kind: "not_found" };

  // job_closeout.job_id is unique (03-schema.sql §11) -- upsert so a retried
  // submission (or a resubmission before dispatch of a corrected voice note)
  // updates the same row rather than erroring.
  const inserted = await tx.query(
    `insert into job_closeout
       (tenant_id, job_id, first_time_fix, technician_voice_note_file,
        technician_note_transcript, client_signature_file, closed_by, closed_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (job_id) do update set
       first_time_fix = excluded.first_time_fix,
       technician_voice_note_file = excluded.technician_voice_note_file,
       technician_note_transcript = excluded.technician_note_transcript,
       client_signature_file = excluded.client_signature_file,
       closed_by = excluded.closed_by,
       closed_at = excluded.closed_at
     returning *;`,
    [
      tenantId,
      jobId,
      body.first_time_fix,
      body.technician_voice_note_file ?? null,
      body.technician_note_transcript,
      body.client_signature_file ?? null,
      userId,
    ]
  );

  // completed_at starts the termo 10-working-day clock (03-schema.sql §7's
  // own comment, 06-phase3-compliance.md §6) and is normally stamped by a
  // separate POST /jobs/:id/complete call first (the office two-step flow).
  // The technician phone flow (prep -> site -> tests -> voice -> done) has
  // no distinct "mark complete" tap -- fieldready-prototype.jsx's settled
  // screens go straight from tests to voice to done, and CLAUDE.md protects
  // that flow from re-litigation -- so closeout is the only moment this
  // path ever reaches. Left as a hard requirement of a prior /complete call,
  // every phone-closed job would have completed_at permanently null and its
  // statutory deadline clock would never start. coalesce() preserves the
  // office flow's earlier, more precise timestamp when it exists, and fills
  // the gap for the phone flow when it doesn't -- found live-testing this
  // exact path, not a hypothetical.
  await tx.query(
    `update job set status = 'closed', completed_at = coalesce(completed_at, now())
     where id = $1 and tenant_id = $2;`,
    [jobId, tenantId]
  );

  return { kind: "ok", row: inserted.rows[0] };
}
