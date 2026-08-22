// 05-phase2-job-loop.md §6a, 04-API-SPEC.md §5 — the dispatch gate. Kept
// pure of any Fastify types (only DbTx) so it's unit-testable
// standalone, same as job-creation.ts's own note about itself. The route
// (routes/jobs.ts POST /jobs/:id/dispatch) just maps {ok:true}/{ok:false}
// to 200/409.
//
// Implements the four conditions from API spec §5 exactly:
//   a. every mandatory job_checklist_item with scope=job has status=ok
//   b. every job_checklist_item with scope=van is "covered" by a
//      not-yet-stale van_audit
//   c. every instrument referenced by the job's resolved
//      test_protocol_snapshot has current calibration
//   d. if tenant.compliance_profile != basic, ited_classification has
//      actually been reviewed by a human, not just defaulted

import type { DbTx } from "../db.js";

export type DispatchBlockingReason =
  | { kind: "checklist_item"; item_id: string; label: string }
  | { kind: "van_audit_stale"; van_label: string | null; next_due_at: string | null }
  | { kind: "calibration_expired"; equipment_id: string; kind_label: string; expired_on: string | null }
  | { kind: "ited_classification_unreviewed"; job_id: string; ited_classification: string };

export type DispatchGateResult =
  | { ok: true }
  | { ok: false; blocking: DispatchBlockingReason[] };

// Normalizes whatever a Postgres driver hands back for a `date` column —
// PGlite (like most drivers) parses it into a JS Date object, not a plain
// string, contrary to what this file used to assume — into a real
// 'YYYY-MM-DD' string. A date-only string parses as UTC midnight per the
// ECMAScript date-string spec, so slicing toISOString() is timezone-safe
// regardless of which shape the driver actually returned.
function toIsoDate(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

/**
 * Evaluates the dispatch gate for `jobId`. Queries the job row, its
 * checklist rows, the tenant's most recent van_audit, the tenant's
 * compliance_profile, and any equipment referenced by the resolved
 * test_protocol_snapshot -- all inside the caller's transaction (RLS
 * already scopes every one of these reads to the current tenant, same
 * principle as templates.ts/job-creation.ts).
 *
 * Precondition: the caller has already confirmed the job exists (the route
 * does its own 404 check before calling this, same pattern as every other
 * job-scoped route in jobs.ts) -- this function throws if it doesn't find
 * the job, rather than returning a not_found variant, to keep the return
 * type exactly the {ok:true}/{ok:false, blocking} shape the design doc
 * specifies.
 */
export async function evaluateDispatchGate(
  tx: DbTx,
  tenantId: string,
  jobId: string
): Promise<DispatchGateResult> {
  const jobRows = await tx.query<{
    id: string;
    ited_classification: string;
    ited_classification_by: string | null;
    test_protocol_snapshot: unknown;
  }>(
    `select id, ited_classification, ited_classification_by, test_protocol_snapshot
     from job where id = $1;`,
    [jobId]
  );
  if (jobRows.rows.length === 0) {
    throw new Error(`evaluateDispatchGate: job ${jobId} not found for tenant ${tenantId}`);
  }
  const job = jobRows.rows[0];

  const tenantRows = await tx.query<{ compliance_profile: string }>(
    `select compliance_profile from tenant where id = $1;`,
    [tenantId]
  );
  const complianceProfile = tenantRows.rows[0]?.compliance_profile ?? "basic";

  const blocking: DispatchBlockingReason[] = [];

  // (a) every mandatory job_checklist_item with scope='job' has status='ok'.
  const missingJobItems = await tx.query<{ id: string; label: string }>(
    `select id, label from job_checklist_item
     where job_id = $1 and scope = 'job' and mandatory = true and status <> 'ok'
     order by label;`,
    [jobId]
  );
  for (const item of missingJobItems.rows) {
    blocking.push({ kind: "checklist_item", item_id: item.id, label: item.label });
  }

  // (b) every job_checklist_item with scope='van' is "covered" by a
  // not-stale van_audit. v1 simplification, per 05-phase2-job-loop.md §5a
  // and CLAUDE.md's own instruction here: multi-van assignment-to-job isn't
  // modeled yet (no column links a job to a specific van), so "covered" is
  // interpreted tenant-wide -- the tenant's single most recent van_audit
  // (any van_label) must have next_due_at >= now(). A real fix would match
  // job.assigned_to's van; out of scope for this phase.
  const vanScopedItems = await tx.query<{ id: string }>(
    `select id from job_checklist_item where job_id = $1 and scope = 'van' limit 1;`,
    [jobId]
  );
  if (vanScopedItems.rows.length > 0) {
    const latestAudit = await tx.query<{ van_label: string; next_due_at: string }>(
      `select van_label, next_due_at from van_audit order by performed_at desc limit 1;`
    );
    const audit = latestAudit.rows[0];
    const stale = !audit || new Date(audit.next_due_at).getTime() < Date.now();
    if (stale) {
      blocking.push({
        kind: "van_audit_stale",
        van_label: audit?.van_label ?? null,
        next_due_at: audit?.next_due_at ?? null,
      });
    }
  }

  // (c) every instrument referenced by the resolved test_protocol_snapshot
  // has current calibration. The seeded/verified test_protocol body shape
  // (packages/core/src/template.ts TestProtocolTest) carries no explicit
  // equipment linkage field today -- there's no schema column to invent one
  // from. Rather than block on data that doesn't exist, this reads an
  // optional `instrument_id` off each test entry defensively (schema-ready
  // for whenever that linkage is added) and treats the condition as
  // vacuously satisfied when no test entry carries one, which is the case
  // for every snapshot resolvable today.
  const snapshot = job.test_protocol_snapshot as { tests?: Array<{ instrument_id?: string }> } | null;
  const instrumentIds = Array.from(
    new Set((snapshot?.tests ?? []).map((t) => t.instrument_id).filter((id): id is string => Boolean(id)))
  );
  if (instrumentIds.length > 0) {
    const equipmentRows = await tx.query<{
      id: string;
      kind: string;
      calibration_expires_on: string | Date | null;
    }>(
      `select id, kind, calibration_expires_on from equipment where id = any($1::uuid[]);`,
      [instrumentIds]
    );
    const byId = new Map(equipmentRows.rows.map((r) => [r.id, r]));
    for (const instrumentId of instrumentIds) {
      const eq = byId.get(instrumentId);
      // Review finding, confirmed against a real table column (not
      // assumed from reading the driver's own claimed types): PGlite (like
      // most Postgres drivers) parses `date` columns into JS Date objects,
      // not plain strings -- this comment used to claim the opposite.
      // Comparing a Date object to a string via `<` coerces the Date
      // through its default toString() (a locale-formatted string like
      // "Fri Aug 21 2026 ..."), NOT toISOString() -- so the lexicographic
      // comparison this function relied on never actually worked. Verified
      // directly: it returned false for BOTH an expired (2020) and a
      // not-yet-expired (2099) calibration date, meaning dispatch never
      // actually blocked on expired equipment since this condition was
      // written -- a real, silent gap in a compliance-relevant gate,
      // caught only while porting this logic to Supabase's rpc_dispatch_job
      // (a pure-SQL date comparison there, with no JS coercion pitfall to
      // hit) and finding the two implementations disagreed. Fixed by
      // normalizing whatever the driver hands back to a real 'YYYY-MM-DD'
      // string before comparing either side, instead of trusting `<` to
      // do the right thing with mixed types.
      const expiresOn = toIsoDate(eq?.calibration_expires_on ?? null);
      const todayIso = new Date().toISOString().slice(0, 10);
      const expired = !eq || expiresOn === null || expiresOn < todayIso;
      if (expired) {
        blocking.push({
          kind: "calibration_expired",
          equipment_id: instrumentId,
          kind_label: eq?.kind ?? "unknown",
          expired_on: expiresOn,
        });
      }
    }
  }

  // (d) if tenant.compliance_profile != 'basic': ited_classification must
  // have actually been reviewed, not merely left at its default. PRD §7:
  // "Default every job into existing_alteration unless a human explicitly
  // downgrades it" -- since the column always has a non-null default, a
  // non-null CHECK can't distinguish "reviewed and confirmed as-is" from
  // "never touched". The most defensible reading (API spec §5's wording is
  // terse here) is that a human must have explicitly gone through
  // PATCH /jobs/:id at least once, even to confirm the default --
  // ited_classification_by is stamped from the verified office session
  // only on that route (jobs.ts), never at job-creation time, so
  // IS NOT NULL is exactly "an office user touched this".
  if (complianceProfile !== "basic" && job.ited_classification_by === null) {
    blocking.push({
      kind: "ited_classification_unreviewed",
      job_id: jobId,
      ited_classification: job.ited_classification,
    });
  }

  if (blocking.length === 0) return { ok: true };
  return { ok: false, blocking };
}
