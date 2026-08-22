// 05-phase2-job-loop.md §7 / §9. The core "validate + write" logic behind
// POST /jobs/:id/test-results, factored out so the direct HTTP route (office
// web UI) and the sync mutation handler (test_result.record, phone/offline)
// call the exact same code path -- two independent implementations of
// "insert a test result" would drift (this task's own correctness
// requirement).
//
// outcome is computed here, once, via evalTest against the matching test
// definition inside the job's frozen test_protocol_snapshot (architecture
// §5's "resolved once, never re-read" rule -- reads the snapshot already on
// the job row, never template/template_version again), matched by
// test_code == snapshot test.id. No match in the snapshot (protocol doesn't
// cover this test, or the job has no test_protocol_snapshot at all) ->
// outcome='na', per spec.

import { evalTest, type JobTestResultRecordRequest, type TestProtocolBody } from "@fieldready/core";
import type { DbTx } from "../db.js";

export type RecordTestResultResult =
  | { kind: "ok"; row: Record<string, unknown> }
  | { kind: "not_found" };

export async function recordTestResult(
  tx: DbTx,
  tenantId: string,
  jobId: string,
  userId: string,
  body: JobTestResultRecordRequest
): Promise<RecordTestResultResult> {
  const jobRows = await tx.query<{ test_protocol_snapshot: TestProtocolBody | null }>(
    `select test_protocol_snapshot from job where id = $1;`,
    [jobId]
  );
  if (jobRows.rows.length === 0) return { kind: "not_found" };

  const snapshot = jobRows.rows[0].test_protocol_snapshot;
  const matchingTest = snapshot?.tests?.find((t) => t.id === body.test_code);
  const outcome = matchingTest ? evalTest(matchingTest, body.measured_value) : "na";

  const inserted = await tx.query(
    `insert into job_test_result
       (tenant_id, job_id, network_type, location_label, test_code, measured_value,
        unit, limit_ref, outcome, performed_at, performed_by, capture_source,
        raw_capture_file, instrument_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, $13)
     returning *;`,
    [
      tenantId,
      jobId,
      body.network_type,
      body.location_label,
      body.test_code,
      body.measured_value,
      body.unit ?? null,
      body.limit_ref ?? null,
      outcome,
      userId,
      body.capture_source,
      body.raw_capture_file ?? null,
      body.instrument_id ?? null,
    ]
  );
  return { kind: "ok", row: inserted.rows[0] };
}
