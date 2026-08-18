// Auth payload validation — 04-API-SPEC.md §1.
// Same schemas validate the Fastify route input and (later) the client
// before it ever hits the network.

import { z } from "zod";

export const OfficeLoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type OfficeLoginRequest = z.infer<typeof OfficeLoginRequest>;

export const TechnicianPairRequest = z.object({
  inviteToken: z.string().min(1),
  deviceLabel: z.string().min(1),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
});
export type TechnicianPairRequest = z.infer<typeof TechnicianPairRequest>;

export const TechnicianLoginRequest = z.object({
  deviceId: z.string().uuid(),
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
});
export type TechnicianLoginRequest = z.infer<typeof TechnicianLoginRequest>;

// Decoded shape of the session JWT — never trust a client-supplied tenant_id
// (API spec §1); this is always minted server-side from the DB row at login.
export const SessionClaims = z.object({
  tenant_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(["owner", "office", "technician"]),
  device_id: z.string().uuid().optional(), // present for technician sessions only
});
export type SessionClaims = z.infer<typeof SessionClaims>;
