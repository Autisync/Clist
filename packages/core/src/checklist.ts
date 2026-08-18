// Readiness checklist + van audit validation — 04-API-SPEC.md §5, §5a;
// 03-schema.sql §7. 05-phase2-job-loop.md §5/§5a.
//
// CLAUDE.md non-negotiable: never add a "confirm all" / bulk-pass shortcut
// here — status is set one item at a time, by id, always.

import { z } from "zod";

// PATCH /jobs/:id/checklist/:item_id — office-side direct write. The phone
// never calls this route directly (§5: it goes through POST
// /sync/mutations instead, see sync.ts's checklist_item.update mutation,
// whose payload additionally carries item_id since the mutation envelope
// has no URL param to carry it in).
export const JobChecklistItemUpdateRequest = z.object({
  status: z.enum(["ok", "missing"]),
});
export type JobChecklistItemUpdateRequest = z.infer<typeof JobChecklistItemUpdateRequest>;

// One issue found during a van audit (03-schema.sql §7, van_audit.issues
// jsonb). item_id is optional — an issue doesn't have to trace back to a
// specific catalog_item (e.g. "alicate partido" in the prototype's fixture).
export const VanAuditIssue = z.object({
  item_id: z.string().uuid().optional(),
  label: z.string().min(1),
  note: z.string().min(1),
});
export type VanAuditIssue = z.infer<typeof VanAuditIssue>;

// POST /van-audits (§5a — closing the gap 04-API-SPEC.md left open).
// next_due_at is NOT part of the request: it's computed server-side from
// performed_at + the tenant's audit interval (§5a — a constant for now).
export const CreateVanAuditRequest = z.object({
  van_label: z.string().min(1),
  issues: z.array(VanAuditIssue).default([]),
});
export type CreateVanAuditRequest = z.infer<typeof CreateVanAuditRequest>;
