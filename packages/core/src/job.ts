// Job header validation — 04-API-SPEC.md §5, 03-schema.sql §7.

import { z } from "zod";

export const ItedClassification = z.enum([
  "licensed",
  "existing_alteration",
  "out_of_scope",
  "exempt",
]);
export type ItedClassification = z.infer<typeof ItedClassification>;

// PATCH /jobs/:id — office edits only (schedule, assignment,
// ited_classification). CLAUDE.md / PRD §7: the technician never
// classifies anything, and ited_classification defaults to the safe,
// over-inclusive existing_alteration — this route is how a human in the
// office overrides that default.
//
// The .refine below mirrors 03-schema.sql §7's job CHECK constraint
// verbatim:
//   check (
//     ited_classification not in ('out_of_scope', 'exempt')
//     or ited_classification_note is not null
//   )
// so bad input is rejected here, before it ever reaches SQL, rather than
// surfacing as a raw constraint violation.
export const JobPatchRequest = z
  .object({
    scheduled_at: z.string().datetime().optional(),
    assigned_to: z.string().uuid().optional(),
    ited_classification: ItedClassification.optional(),
    ited_classification_note: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.ited_classification === undefined ||
      !(v.ited_classification === "out_of_scope" || v.ited_classification === "exempt") ||
      v.ited_classification_note !== undefined,
    {
      message:
        "ited_classification_note is required when ited_classification is out_of_scope or exempt",
      path: ["ited_classification_note"],
    }
  );
export type JobPatchRequest = z.infer<typeof JobPatchRequest>;
