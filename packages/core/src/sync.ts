// Offline sync envelope — 04-API-SPEC.md §9, architecture §4 (Option B,
// custom queue). Phase 1 registers exactly one mutation handler
// (checklist_item.update) per architecture §8: "carrying nothing but a
// trivial ping mutation end-to-end. No job domain logic yet." Using the
// API spec's own illustrative example as that trivial mutation means the
// wire contract is exactly what Phase 2 will keep using, not a throwaway
// shape.

import { z } from "zod";

export const ChecklistItemUpdatePayload = z.object({
  item_id: z.string().uuid(),
  status: z.enum(["ok", "missing"]),
});

export const SyncMutation = z.object({
  client_mutation_id: z.string().uuid(),
  type: z.literal("checklist_item.update"),
  job_id: z.string().uuid(),
  payload: ChecklistItemUpdatePayload,
  occurred_at: z.string().datetime().or(z.string()), // device clock, ordering only — never trusted for business logic
});
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
