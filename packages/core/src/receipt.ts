// Receipt / receipt_line validation — 04-API-SPEC.md §3, 03-schema.sql §5,
// 07-phase4-cost-intelligence.md §5. CreateReceiptRequest validates the
// metadata fields of POST /receipts only -- the image itself travels as a
// separate multipart part, same split as JobPhotoUploadMetadata (photo.ts)
// keeps between metadata JSON and binary bytes.

import { z } from "zod";

export const CreateReceiptRequest = z.object({
  supplier_id: z.string().uuid().optional(),
  doc_number: z.string().min(1).optional(),
  receipt_date: z.string().optional(),
});
export type CreateReceiptRequest = z.infer<typeof CreateReceiptRequest>;

// POST /receipts/:id/confirm -- the only place OCR-derived data ever
// becomes a real supplier_price row (04-API-SPEC.md §3, non-negotiable).
// Selective by design: only the line_ids listed here get confirmed: lines
// left out, and lines with no item_id match, stay untouched.
export const ConfirmReceiptLinesRequest = z.object({
  line_ids: z.array(z.string().uuid()).min(1),
});
export type ConfirmReceiptLinesRequest = z.infer<typeof ConfirmReceiptLinesRequest>;
