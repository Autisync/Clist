// Session tokens — architecture §2 ("session cookie") / §7 (device-bound
// technician session). JWT chosen over a server-side session table so
// Phase 1 doesn't need yet another table for something that isn't the risk
// being proven here; revocation for technicians still checks
// technician_device.revoked_at on every request (§7), so a signed JWT
// alone can't resurrect a revoked device.

import jwt from "jsonwebtoken";
import { SessionClaims, type SessionClaims as SessionClaimsT } from "@fieldready/core";

const SECRET = process.env.SESSION_JWT_SECRET ?? "dev-only-secret-change-in-deployment";
const OFFICE_SESSION_TTL = "12h";
const TECHNICIAN_SESSION_TTL = "90d"; // field use, not re-login per job — architecture §2

export function signOfficeSession(claims: SessionClaimsT): string {
  return jwt.sign(claims, SECRET, { expiresIn: OFFICE_SESSION_TTL });
}

export function signTechnicianSession(claims: SessionClaimsT): string {
  return jwt.sign(claims, SECRET, { expiresIn: TECHNICIAN_SESSION_TTL });
}

export function verifySession(token: string): SessionClaimsT {
  const decoded = jwt.verify(token, SECRET);
  return SessionClaims.parse(decoded);
}
