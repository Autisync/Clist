// Phase 1 proof fixtures — deliberately NOT built through any job/quote
// business logic (architecture §8: "no job domain logic yet"). Two tenants
// for the isolation proof, one office login + one technician device for the
// auth proof, and exactly one pre-existing job + checklist item as the
// target of the trivial sync mutation — inserted directly, the same way
// verify-schema.mjs's own fixtures are, not via any endpoint.

import type { PGlite } from "@electric-sql/pglite";
import bcrypt from "bcryptjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { RUNTIME_DIR } from "./runtime-dir.js";
import path from "node:path";

// <runtime dir>/phase1-fixtures.json — read by test/phase1-proof.mjs. Not an
// API endpoint on purpose: nothing in the real product should ever return
// "here are some IDs to log in as," this file exists only so the proof
// script can address fixtures it just watched get created on disk. See
// db.ts for why RUNTIME_DIR isn't inside the repo folder.
const FIXTURE_IDS_PATH = path.join(RUNTIME_DIR, "phase1-fixtures.json");

export const PHASE1_FIXTURES = {
  tenantA: { slug: "antenas-piloto", name: "Antenas Piloto, Lda" },
  tenantB: { slug: "concorrente", name: "Concorrente, Lda" },
  officeAEmail: "rex@antenas-piloto.pt",
  officeAPassword: "proof-pass-123",
  officeBEmail: "owner@concorrente.pt",
  officeBPassword: "proof-pass-456",
  technicianPin: "1234",
  technicianDeviceLabel: "Rui — telemóvel de proof",
} as const;

export async function seedPhase1Fixtures(db: PGlite): Promise<void> {
  const existing = await db.query<{ id: string }>(
    `select id from tenant where slug = $1;`,
    [PHASE1_FIXTURES.tenantA.slug]
  );
  if (existing.rows.length > 0) return; // already seeded — idempotent across restarts

  const tenantA = await db.query<{ id: string }>(
    `insert into tenant (name, slug, compliance_profile) values ($1, $2, 'ited_ready') returning id;`,
    [PHASE1_FIXTURES.tenantA.name, PHASE1_FIXTURES.tenantA.slug]
  );
  const tenantAId = tenantA.rows[0].id;

  const tenantB = await db.query<{ id: string }>(
    `insert into tenant (name, slug) values ($1, $2) returning id;`,
    [PHASE1_FIXTURES.tenantB.name, PHASE1_FIXTURES.tenantB.slug]
  );
  const tenantBId = tenantB.rows[0].id;

  const officeAHash = await bcrypt.hash(PHASE1_FIXTURES.officeAPassword, 10);
  const officeA = await db.query<{ id: string }>(
    `insert into app_user (tenant_id, role, full_name, email, password_hash)
     values ($1, 'owner', 'Rex', $2, $3) returning id;`,
    [tenantAId, PHASE1_FIXTURES.officeAEmail, officeAHash]
  );
  const officeAId = officeA.rows[0].id;

  const officeBHash = await bcrypt.hash(PHASE1_FIXTURES.officeBPassword, 10);
  await db.query(
    `insert into app_user (tenant_id, role, full_name, email, password_hash)
     values ($1, 'owner', 'Dono Concorrente', $2, $3);`,
    [tenantBId, PHASE1_FIXTURES.officeBEmail, officeBHash]
  );

  const technician = await db.query<{ id: string }>(
    `insert into app_user (tenant_id, role, full_name)
     values ($1, 'technician', 'Rui A.') returning id;`,
    [tenantAId]
  );
  const technicianId = technician.rows[0].id;

  const pinHash = await bcrypt.hash(PHASE1_FIXTURES.technicianPin, 10);
  const device = await db.query<{ id: string }>(
    `insert into technician_device (tenant_id, user_id, device_label, pin_hash, paired_by)
     values ($1, $2, $3, $4, $5) returning id;`,
    [tenantAId, technicianId, PHASE1_FIXTURES.technicianDeviceLabel, pinHash, officeAId]
  );

  const client = await db.query<{ id: string }>(
    `insert into client (tenant_id, name) values ($1, 'F. Marques') returning id;`,
    [tenantAId]
  );

  const job = await db.query<{ id: string }>(
    `insert into job (tenant_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
     values ($1, $2, 'JOB-PROOF-0001', 'Instalação antena TDT — proof', 'TDT novo', 3.5, 214.6)
     returning id;`,
    [tenantAId, client.rows[0].id]
  );

  const checklistItem = await db.query<{ id: string }>(
    `insert into job_checklist_item (tenant_id, job_id, cat, label, scope, mandatory, status)
     values ($1, $2, 'material', 'Fonte alimentação 24V', 'job', true, 'missing')
     returning id;`,
    [tenantAId, job.rows[0].id]
  );

  const ids = {
    tenantAId,
    tenantBId,
    officeAId,
    technicianId,
    deviceId: device.rows[0].id,
    jobId: job.rows[0].id,
    checklistItemId: checklistItem.rows[0].id,
  };
  mkdirSync(path.dirname(FIXTURE_IDS_PATH), { recursive: true });
  writeFileSync(FIXTURE_IDS_PATH, JSON.stringify(ids, null, 2));
  console.log("[fixtures] seeded:", ids);
}
