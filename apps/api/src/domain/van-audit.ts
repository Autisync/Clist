// 05-phase2-job-loop.md §5a / §9. The core "validate + write" logic behind
// POST /van-audits, factored out so the direct HTTP route (office web UI)
// and the sync mutation handler (van_audit.record, phone/offline) call the
// exact same code path.

import type { CreateVanAuditRequest } from "@fieldready/core";
import type { PGliteTx } from "../db.js";

// forms-and-procedures-spec.md F04 — "weekly, configurable". Configurable
// per-tenant intervals are a real future feature (a small addition to
// `tenant` if/when it's needed) -- not required for Phase 2's loop to work
// end to end, so this stays a hardcoded constant until then.
export const VAN_AUDIT_INTERVAL_DAYS = 7;

export type RecordVanAuditRow = {
  id: string;
  van_label: string;
  performed_at: string;
  next_due_at: string;
};

export async function recordVanAudit(
  tx: PGliteTx,
  tenantId: string,
  userId: string,
  body: CreateVanAuditRequest
): Promise<RecordVanAuditRow> {
  const created = await tx.query<RecordVanAuditRow>(
    `insert into van_audit (tenant_id, van_label, performed_by, performed_at, next_due_at, issues)
     values ($1, $2, $3, now(), now() + ($4 || ' days')::interval, $5)
     returning id, van_label, performed_at, next_due_at;`,
    [tenantId, body.van_label, userId, String(VAN_AUDIT_INTERVAL_DAYS), JSON.stringify(body.issues)]
  );
  return created.rows[0];
}
