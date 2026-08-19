// F17 — statutory deadlines (06-phase3-compliance.md §6). The pure
// working-day arithmetic lives in packages/core/src/deadlines.ts
// (addWorkingDays); this file's job is only reading a tenant's PT
// working-day-calendar options (country/municipality) and inserting the
// resulting compliance_deadline row -- called from two places, per that
// section:
//   - domain/closeout.ts's submitCloseout, right after job.completed_at
//     transitions from null to set (kind="termo").
//   - routes/termo.ts, right after a termo_responsabilidade row is
//     inserted (kind="ref").

// Imported from deadlines.ts directly, NOT the "@fieldready/core" barrel --
// see packages/core/src/index.ts's comment on why: date-holidays is real
// weight this file needs server-side, but must never reach apps/web's
// client bundles through the barrel.
import { addWorkingDays, type AddWorkingDaysOptions } from "@fieldready/core/src/deadlines.js";
import type { PGliteTx } from "../db.js";

const STATUTORY_DEADLINE_WORKING_DAYS = 10;

async function tenantHolidayOptions(tx: PGliteTx, tenantId: string): Promise<AddWorkingDaysOptions> {
  const rows = await tx.query<{ country: string; municipality: string | null }>(
    `select country, municipality from tenant where id = $1;`,
    [tenantId]
  );
  const tenant = rows.rows[0];
  return {
    country: tenant?.country ?? "PT",
    subdivision: tenant?.municipality ?? undefined,
  };
}

/**
 * termo clock: due within 10 working days of job.completed_at
 * (03-schema.sql §10 comment). Insert exactly once per job -- callers are
 * responsible for only invoking this the moment completed_at is first set,
 * not on a retried/idempotent closeout submission.
 */
export async function insertTermoDeadline(
  tx: PGliteTx,
  tenantId: string,
  jobId: string,
  completedAt: Date
): Promise<void> {
  const options = await tenantHolidayOptions(tx, tenantId);
  const dueOn = addWorkingDays(completedAt, STATUTORY_DEADLINE_WORKING_DAYS, options);
  await tx.query(
    `insert into compliance_deadline (tenant_id, job_id, kind, due_on)
     values ($1, $2, 'termo', $3);`,
    [tenantId, jobId, dueOn.toISOString().slice(0, 10)]
  );
}

/**
 * REF clock: due within 10 working days of
 * termo_responsabilidade.issued_at (03-schema.sql §10 comment). Insert
 * exactly once per job -- termo_responsabilidade.job_id is unique, so
 * routes/termo.ts's POST /jobs/:id/termo can only ever succeed once per
 * job, which is the only place this is called from.
 */
export async function insertRefDeadline(
  tx: PGliteTx,
  tenantId: string,
  jobId: string,
  issuedAt: Date
): Promise<void> {
  const options = await tenantHolidayOptions(tx, tenantId);
  const dueOn = addWorkingDays(issuedAt, STATUTORY_DEADLINE_WORKING_DAYS, options);
  await tx.query(
    `insert into compliance_deadline (tenant_id, job_id, kind, due_on)
     values ($1, $2, 'ref', $3);`,
    [tenantId, jobId, dueOn.toISOString().slice(0, 10)]
  );
}
