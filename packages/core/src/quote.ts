// Quote / BOM validation — 04-API-SPEC.md §4, 03-schema.sql §6,
// 05-phase2-job-loop.md §3 (F01/F02). `POST /quotes`, `PATCH
// /quotes/:id/lines`, `POST /quotes/:id/accept` are "straightforward CRUD
// against quote/quote_line -- no gate, no snapshot logic" per §3; the
// snapshot-resolution logic lives in job.ts (create-job), not here.

import { z } from "zod";

export const CreateQuoteRequest = z.object({
  client_id: z.string().uuid(),
  job_type: z.string().min(1),
  quoted_hours: z.number().nonnegative(),
  quoted_materials: z.number().nonnegative(),
});
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequest>;

// One line of the BOM. `item_id` is optional — a line can reference a
// catalog_item or be free text (03-schema.sql §6, quote_line.item_id is
// nullable).
export const QuoteLineInput = z.object({
  item_id: z.string().uuid().optional(),
  description: z.string().min(1),
  qty: z.number().positive().default(1),
  planned_supplier_id: z.string().uuid().optional(),
  unit_price: z.number().nonnegative(),
});
export type QuoteLineInput = z.infer<typeof QuoteLineInput>;

// PATCH /quotes/:id/lines — full replace of the BOM, per §3.
export const UpdateQuoteLinesRequest = z.object({
  lines: z.array(QuoteLineInput),
});
export type UpdateQuoteLinesRequest = z.infer<typeof UpdateQuoteLinesRequest>;

// POST /quotes/:id/accept has no request body (§3: "accept just stamps
// accepted_at and flips status, nothing else") — no schema needed, the
// route takes no input beyond the :id param.

// POST /quotes/:id/create-job also has no request body — see job.ts for the
// snapshot-resolution logic §4 describes; the route itself takes no input
// beyond the :id param either.
