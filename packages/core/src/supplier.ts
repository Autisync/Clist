// Supplier / supplier_price validation — 04-API-SPEC.md §3, 03-schema.sql §5,
// 07-phase4-cost-intelligence.md §3/§4. Same "trivial CRUD" shape as
// catalog.ts/client.ts, plus the one write path (RecordSupplierPriceRequest)
// that both the manual-entry route (apps/api/src/routes/suppliers.ts) and
// the future receipt-confirm route (07-phase4-cost-intelligence.md §5) share.

import { z } from "zod";

// supplier.hours jsonb shape (03-schema.sql §5 comment):
// [{dow:0..6, open:'08:00', close:'18:30'} | null] — one entry per index,
// index == JS Date#getDay() (0 = Sunday .. 6 = Saturday), null meaning
// closed that day. Matches fieldready-prototype.jsx's WEEK()/openState()
// indexing exactly (SUPPLIERS array, ~line 43).
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const SupplierHoursSlot = z
  .object({
    dow: z.number().int().min(0).max(6),
    open: z.string().regex(HHMM, "expected HH:MM"),
    close: z.string().regex(HHMM, "expected HH:MM"),
  })
  .nullable();
export type SupplierHoursSlot = z.infer<typeof SupplierHoursSlot>;

export const SupplierHours = z.array(SupplierHoursSlot);
export type SupplierHours = z.infer<typeof SupplierHours>;

export const CreateSupplierRequest = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  account_note: z.string().optional(),
  place_id: z.string().optional(),
  distance_km: z.number().nonnegative().optional(),
  hours: SupplierHours.optional(),
});
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequest>;

export const UpdateSupplierRequest = z.object({
  name: z.string().min(1).optional(),
  category: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  account_note: z.string().optional(),
  place_id: z.string().optional(),
  distance_km: z.number().nonnegative().optional(),
  hours: SupplierHours.optional(),
});
export type UpdateSupplierRequest = z.infer<typeof UpdateSupplierRequest>;

// Shared by POST /suppliers/:id/prices (manual, source pinned to "manual"
// by the route itself — 07-phase4-cost-intelligence.md §3) and the future
// POST /receipts/:id/confirm (source "receipt", §5). The schema allows both
// values here because the *shape* of a price write is identical either way;
// which route is allowed to use which source is an application-layer rule,
// not a validation-layer one.
export const RecordSupplierPriceRequest = z.object({
  item_id: z.string().uuid(),
  price: z.number().positive(),
  source: z.enum(["receipt", "manual"]),
});
export type RecordSupplierPriceRequest = z.infer<typeof RecordSupplierPriceRequest>;
