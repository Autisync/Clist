// Test result recording — 04-API-SPEC.md §5 (`POST /jobs/:id/test-results`),
// 03-schema.sql §9 (job_test_result). Field set and enum values match
// job_test_result's columns exactly: network_type, capture_source. `outcome`
// is NOT part of the request — it's computed server-side via evalTest
// (test-protocol-eval.ts), same evaluator the phone runs locally for
// instant pass/fail before sync (05-phase2-job-loop.md §7), so client and
// server can't disagree.
//
// capture_source: photo_ocr leads, manual is the fallback, for every
// capture in the fleet today (CLAUDE.md). instrument_export is
// schema-ready only — confirmed inactive fleet-wide, 18 Aug — kept as a
// valid enum value, not built toward as a near-term path.

import { z } from "zod";

export const JobTestResultRecordRequest = z.object({
  network_type: z.enum(["PC", "CC", "FO", "SMATV"]),
  location_label: z.string().min(1),
  test_code: z.string().min(1),
  measured_value: z.string(),
  unit: z.string().optional(),
  limit_ref: z.string().optional(),
  capture_source: z.enum(["instrument_export", "photo_ocr", "manual"]),
  raw_capture_file: z.string().optional(),
  instrument_id: z.string().uuid().optional(),
});
export type JobTestResultRecordRequest = z.infer<typeof JobTestResultRecordRequest>;
