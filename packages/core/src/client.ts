// Client (customer) validation — 04-API-SPEC.md §4, 03-schema.sql §6.
// Trivial CRUD, same "unblocks everything else's fixtures" build-order note
// as catalog.ts (05-phase2-job-loop.md §2 step 1).

import { z } from "zod";

export const CreateClientRequest = z.object({
  name: z.string().min(1),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});
export type CreateClientRequest = z.infer<typeof CreateClientRequest>;

export const UpdateClientRequest = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
});
export type UpdateClientRequest = z.infer<typeof UpdateClientRequest>;
