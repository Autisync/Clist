// Job photo upload metadata — 04-API-SPEC.md §5 (`POST /jobs/:id/photos`),
// 03-schema.sql §11. 05-phase2-job-loop.md §7: this validates the metadata
// fields only — the binary itself travels as a separate multipart part,
// not through this JSON schema, and never through the sync envelope
// (§7: "forcing image bytes through a JSON batch mutation is exactly the
// kind of premature-generality API spec §9 already warns against").

import { z } from "zod";

export const JobPhotoUploadMetadata = z.object({
  phase: z.enum(["before", "during", "after", "evidence"]),
  required_tag: z.string().min(1).optional(),
});
export type JobPhotoUploadMetadata = z.infer<typeof JobPhotoUploadMetadata>;
