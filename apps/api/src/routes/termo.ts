// F16 — termo de responsabilidade tracking. 06-phase3-compliance.md §5,
// 04-API-SPEC.md §7. Same route-file pattern as ref.ts: requireAuth
// preHandler, the compliance-profile 403 gate checked first inside the
// same withTenant transaction the rest of the route runs in, and the
// ref/termo reconciliation trigger's exception translated to a clean 422
// (catch, regex on the message, translate) rather than re-implemented as a
// second, driftable application-layer check.
//
// Only reachable for ited_ready/ited_full tenants (API spec §7): every
// route here 403s for compliance_profile = 'basic'.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  CreateTermoRequest,
  PatchTermoRecipientRequest,
  TermoRecipientRole,
  type TermoRecipient,
} from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { objectStore } from "../object-store.js";
import { insertRefDeadline } from "../domain/deadlines.js";

const COMPLIANCE_PROFILE_REQUIRED_ERROR = {
  error: "compliance_profile_basic",
  message: "Termo tracking requires the tenant's compliance_profile to be ited_ready or ited_full (API spec §7).",
};

// Mirrors fn_termo_ref_reconciliation's exact raise message (03-schema.sql
// §10 — the symmetric trigger on termo_responsabilidade, same message
// shape as fn_ref_termo_reconciliation so this one regex catches either
// direction) — catch, regex on the message, translate, same pattern
// routes/ref.ts and routes/templates.ts already use for their own
// trigger-backed gates. Deliberately not re-implemented as a second
// application-layer check that could drift from the trigger's actual
// condition.
const REF_TERMO_MISMATCH_REGEX = /does not match termo_responsabilidade\.ref_id_field/;
function refTermoMismatchError(message: string) {
  return { error: "ref_termo_mismatch", message };
}

async function tenantComplianceProfile(
  tx: import("../db.js").DbTx,
  tenantId: string
): Promise<string> {
  const rows = await tx.query<{ compliance_profile: string }>(
    `select compliance_profile from tenant where id = $1;`,
    [tenantId]
  );
  return rows.rows[0]?.compliance_profile ?? "basic";
}

export async function termoRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{ Params: { id: string } }>("/jobs/:id/termo", async (req, reply) => {
    const body = CreateTermoRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
        return { kind: "forbidden" as const };
      }

      const jobRows = await tx.query(`select id from job where id = $1;`, [jobId]);
      if (jobRows.rows.length === 0) return { kind: "job_not_found" as const };

      const existing = await tx.query(`select id from termo_responsabilidade where job_id = $1;`, [jobId]);
      if (existing.rows.length > 0) return { kind: "already_exists" as const };

      try {
        const inserted = await tx.query(
          `insert into termo_responsabilidade (tenant_id, job_id, number, ref_id_field, issued_at, anacom_area_ref)
           values ($1, $2, $3, $4, $5, $6)
           returning *;`,
          [tenantId, jobId, body.number, body.ref_id_field, body.issued_at, body.anacom_area_ref ?? null]
        );
        // F17 (06-phase3-compliance.md §6): the REF 10-working-day clock
        // starts the moment a termo is issued. termo_responsabilidade.job_id
        // is unique (03-schema.sql §10), so this insert -- and this
        // deadline -- can only ever happen once per job.
        await insertRefDeadline(tx, tenantId, jobId, new Date(body.issued_at));
        return { kind: "ok" as const, row: inserted.rows[0] };
      } catch (err) {
        if (err instanceof Error && REF_TERMO_MISMATCH_REGEX.test(err.message)) {
          return { kind: "mismatch" as const, message: err.message };
        }
        throw err;
      }
    });

    if (outcome.kind === "forbidden") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);
    if (outcome.kind === "job_not_found") return reply.code(404).send({ error: "job_not_found" });
    if (outcome.kind === "already_exists")
      return reply
        .code(409)
        .send({ error: "termo_already_exists", message: "This job already has a termo_responsabilidade." });
    if (outcome.kind === "mismatch") return reply.code(422).send(refTermoMismatchError(outcome.message));
    return reply.code(201).send(outcome.row);
  });

  app.patch<{ Params: { id: string; role: string } }>(
    "/jobs/:id/termo/recipients/:role",
    async (req, reply) => {
      const roleResult = TermoRecipientRole.safeParse(req.params.role);
      if (!roleResult.success) {
        return reply.code(400).send({
          error: "invalid_role",
          message: `role must be one of: ${TermoRecipientRole.options.join(", ")}.`,
        });
      }
      const role = roleResult.data;
      const body = PatchTermoRecipientRequest.parse(req.body);
      const tenantId = req.auth!.tenant_id;
      const jobId = req.params.id;

      const outcome = await withTenant(tenantId, async (tx) => {
        if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
          return { kind: "forbidden" as const };
        }

        const rows = await tx.query<{ id: string; recipients: TermoRecipient[] }>(
          `select id, recipients from termo_responsabilidade where job_id = $1;`,
          [jobId]
        );
        if (rows.rows.length === 0) return { kind: "not_found" as const };
        const existing = rows.rows[0];

        // Read-modify-write over the jsonb array (06-phase3-compliance.md
        // §5) -- find the entry by role, update it in place, or append a
        // new one if this role hasn't been recorded yet.
        const recipients = [...(existing.recipients ?? [])];
        const index = recipients.findIndex((r) => r.role === role);
        if (index >= 0) {
          recipients[index] = { ...recipients[index], sent_at: body.sent_at };
        } else {
          recipients.push({ role, sent_at: body.sent_at });
        }

        const updated = await tx.query(
          `update termo_responsabilidade set recipients = $1 where id = $2 returning *;`,
          [JSON.stringify(recipients), existing.id]
        );
        return { kind: "ok" as const, row: updated.rows[0] };
      });

      if (outcome.kind === "forbidden") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);
      if (outcome.kind === "not_found") return reply.code(404).send({ error: "termo_not_found" });
      return reply.send(outcome.row);
    }
  );

  // Multipart upload, same shape as POST /jobs/:id/photos (jobs.ts) --
  // binary bytes travel as their own part, written straight through the
  // existing ObjectStore, no second upload mechanism.
  app.post<{ Params: { id: string } }>("/jobs/:id/termo/paper-copy-photo", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const forbidden = await withTenant(tenantId, (tx) => tenantComplianceProfile(tx, tenantId));
    if (forbidden === "basic") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);

    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: "no_file", message: "Expected a multipart file part." });
    }

    const buffer = await data.toBuffer();
    const key = crypto.randomUUID();
    await objectStore.put(key, buffer);

    const result = await withTenant(tenantId, async (tx) => {
      const rows = await tx.query(`select id from termo_responsabilidade where job_id = $1;`, [jobId]);
      if (rows.rows.length === 0) return { kind: "not_found" as const };

      const updated = await tx.query(
        `update termo_responsabilidade set paper_copy_photo = $1 where job_id = $2 returning *;`,
        [key, jobId]
      );
      return { kind: "ok" as const, row: updated.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "termo_not_found" });
    return reply.send(result.row);
  });
}
