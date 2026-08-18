// Equipment & calibration validation — 04-API-SPEC.md §6, 03-schema.sql §8.
// The calibration gate itself (dispatch blocked when calibration_expires_on
// has lapsed) is dispatch-gate.ts's job (05-phase2-job-loop.md §6a); this
// file only validates the CRUD requests that feed those columns.

import { z } from "zod";

export const CreateEquipmentRequest = z.object({
  kind: z.string().min(1),
  make: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  // Confirmed false fleet-wide, 18 Aug (architecture §2, CLAUDE.md) — kept
  // as a real field, not hardcoded, since the schema is meter-purchase-ready.
  supports_export: z.boolean().default(false),
});
export type CreateEquipmentRequest = z.infer<typeof CreateEquipmentRequest>;

export const UpdateEquipmentRequest = z.object({
  kind: z.string().min(1).optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  supports_export: z.boolean().optional(),
});
export type UpdateEquipmentRequest = z.infer<typeof UpdateEquipmentRequest>;

// POST /equipment/:id/calibration — §6.
export const RecordCalibrationRequest = z.object({
  cert_file: z.string().min(1),
  issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
});
export type RecordCalibrationRequest = z.infer<typeof RecordCalibrationRequest>;
