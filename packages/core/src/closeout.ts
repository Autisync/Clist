// Close-out (F19) validation — 04-API-SPEC.md §5
// (`POST /jobs/:id/closeout`, `PATCH /jobs/:id/closeout/rework-cause`),
// 03-schema.sql §11 (job_closeout, follow_up_action). 05-phase2-job-loop.md
// §8.
//
// CLAUDE.md / PRD §6: rework_cause is office-assigned taxonomy and is NOT
// technician-set. That's enforced here by simply never defining the field
// on JobCloseoutTechnicianRequest — not by a role check on a shared schema
// that could be gotten wrong — and by giving it its own separate schema on
// its own separate office-only route.

import { z } from "zod";

// POST /jobs/:id/closeout — technician-facing. Deliberately has no
// rework_cause field at all.
export const JobCloseoutTechnicianRequest = z.object({
  first_time_fix: z.boolean(),
  technician_note_transcript: z.string().min(1),
  technician_voice_note_file: z.string().optional(),
  client_signature_file: z.string().optional(),
});
export type JobCloseoutTechnicianRequest = z.infer<typeof JobCloseoutTechnicianRequest>;

// PATCH /jobs/:id/closeout/rework-cause — office-only, separate route.
export const JobCloseoutReworkCauseRequest = z.object({
  rework_cause: z.string().min(1),
});
export type JobCloseoutReworkCauseRequest = z.infer<typeof JobCloseoutReworkCauseRequest>;

// follow_up_action rows raised out of a close-out (03-schema.sql §11).
export const CreateFollowUpActionRequest = z.object({
  description: z.string().min(1),
  owner: z.string().optional(),
  owner_user_id: z.string().uuid().optional(),
  due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional(),
});
export type CreateFollowUpActionRequest = z.infer<typeof CreateFollowUpActionRequest>;
