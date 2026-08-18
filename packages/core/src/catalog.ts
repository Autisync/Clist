// Catalog item validation — 04-API-SPEC.md §3, 03-schema.sql §5.
// Trivial CRUD (05-phase2-job-loop.md §2, build-order step 1: "Catalog +
// client CRUD ... unblocks everything else's fixtures") — no gate, no
// snapshot logic, just Zod-validated insert/update inside withTenant like
// every other route in this file group.

import { z } from "zod";

export const CreateCatalogItemRequest = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1).default("un"),
});
export type CreateCatalogItemRequest = z.infer<typeof CreateCatalogItemRequest>;

export const UpdateCatalogItemRequest = z.object({
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
});
export type UpdateCatalogItemRequest = z.infer<typeof UpdateCatalogItemRequest>;
