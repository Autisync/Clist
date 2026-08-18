// Offline sync envelope — 04-API-SPEC.md §9, architecture §4 (Option B,
// custom queue). Phase 1 registers exactly one mutation handler
// (checklist_item.update) per architecture §8: "carrying nothing but a
// trivial ping mutation end-to-end. No job domain logic yet." Using the
// API spec's own illustrative example as that trivial mutation means the
// wire contract is exactly what Phase 2 will keep using, not a throwaway
// shape.
//
// 05-phase2-job-loop.md §9 turns this from one z.literal into a real
// discriminated union covering the mutation types Phase 2 needs
// (execution_step.complete, test_result.record, closeout.submit,
// van_audit.record), each reusing its domain schema so client and server
// validate identically. checklist_item.update below is kept byte-identical
// to Phase 1's shape.
//
// NEXT STAGE: apps/api/src/routes/sync.ts's mutation switch only has a
// checklist_item.update branch today — extending it with a branch per new
// type below (same applied_mutation-lookup-then-apply-then-insert pattern
// already there) is 05-phase2-job-loop.md §9's remaining work, not done in
// this pass.

import { z } from "zod";
import { JobTestResultRecordRequest } from "./test-result.js";
import { JobCloseoutTechnicianRequest } from "./closeout.js";
import { CreateVanAuditRequest } from "./checklist.js";

export const ChecklistItemUpdatePayload = z.object({
  item_id: z.string().uuid(),
  status: z.enum(["ok", "missing"]),
});

export const ChecklistItemUpdateMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("checklist_item.update"),
  job_id: z.string().uuid(),
  payload: ChecklistItemUpdatePayload,
  occurred_at: z.string().datetime().or(z.string()), // device clock, ordering only — never trusted for business logic
});

export const ExecutionStepCompletePayload = z.object({
  step: z.number().int().nonnegative(),
});

export const ExecutionStepCompleteMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("execution_step.complete"),
  job_id: z.string().uuid(),
  payload: ExecutionStepCompletePayload,
  occurred_at: z.string().datetime().or(z.string()),
});

export const TestResultRecordMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("test_result.record"),
  job_id: z.string().uuid(),
  payload: JobTestResultRecordRequest,
  occurred_at: z.string().datetime().or(z.string()),
});

export const CloseoutSubmitMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("closeout.submit"),
  job_id: z.string().uuid(),
  payload: JobCloseoutTechnicianRequest,
  occurred_at: z.string().datetime().or(z.string()),
});

// van_audit rows aren't job-scoped in the DB (03-schema.sql §7,
// van_audit has no job_id column) — job_id here is carried only because
// every mutation shares this envelope shape, and identifies the job the
// technician was on at audit time, not a foreign key the handler writes.
export const VanAuditRecordMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("van_audit.record"),
  job_id: z.string().uuid(),
  payload: CreateVanAuditRequest,
  occurred_at: z.string().datetime().or(z.string()),
});

export const SyncMutation = z.discriminatedUnion("type", [
  ChecklistItemUpdateMutation,
  ExecutionStepCompleteMutation,
  TestResultRecordMutation,
  CloseoutSubmitMutation,
  VanAuditRecordMutation,
]);
export type SyncMutation = z.infer<typeof SyncMutation>;

export const SyncMutationsRequest = z.object({
  mutations: z.array(SyncMutation).min(1),
});
export type SyncMutationsRequest = z.infer<typeof SyncMutationsRequest>;

export const SyncMutationResult = z.object({
  client_mutation_id: z.string().uuid(),
  status: z.enum(["applied", "already_applied", "rejected"]),
  reason: z.string().optional(),
});
export type SyncMutationResult = z.infer<typeof SyncMutationResult>;

export const SyncMutationsResponse = z.object({
  results: z.array(SyncMutationResult),
});
export type SyncMutationsResponse = z.infer<typeof SyncMutationsResponse>;
