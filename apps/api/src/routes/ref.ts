// F15 — REF assembly. 06-phase3-compliance.md §4, 04-API-SPEC.md §7. Same
// route-file-plus-domain-function pattern as jobs.ts: this file stays thin
// (auth, the compliance-profile 403 gate, request validation, translating
// the ref/termo reconciliation trigger's exception into a clean 422 the
// same way templates.ts's activation route already does for the
// test_protocol gate) — the real work (populating ficha_fields, rendering
// the PDF) lives in domain/ref.ts.
//
// Only reachable for ited_ready/ited_full tenants (API spec §7): every
// route here 403s for compliance_profile = 'basic', checked first, inside
// the same withTenant transaction the rest of the route runs in (same
// pattern dispatch-gate.ts/job-creation.ts already use to read
// tenant.compliance_profile).

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateRefDocumentRequest, PatchRefDocumentRequest, type FichaFields } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { populateFichaFields, generateRefPdf } from "../domain/ref.js";
import { objectStore } from "../object-store.js";

const COMPLIANCE_PROFILE_REQUIRED_ERROR = {
  error: "compliance_profile_basic",
  message: "REF assembly requires the tenant's compliance_profile to be ited_ready or ited_full (API spec §7).",
};

// Mirrors fn_ref_termo_reconciliation's exact raise message (03-schema.sql
// §10) — catch, regex on the message, translate, same pattern
// templates.ts's activation route uses for fn_activate_template_version_guard.
// Deliberately not re-implemented as a second application-layer check that
// could drift from the trigger's actual condition.
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

export async function refRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post<{ Params: { id: string } }>("/jobs/:id/ref", async (req, reply) => {
    const body = CreateRefDocumentRequest.parse(req.body ?? {});
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
        return { kind: "forbidden" as const };
      }

      const jobRows = await tx.query<{ id: string; code: string }>(
        `select id, code from job where id = $1;`,
        [jobId]
      );
      if (jobRows.rows.length === 0) return { kind: "job_not_found" as const };
      const job = jobRows.rows[0];

      const existing = await tx.query(`select id from ref_document where job_id = $1;`, [jobId]);
      if (existing.rows.length > 0) return { kind: "already_exists" as const };

      const fichaFields = await populateFichaFields(tx, tenantId, jobId);
      // ref_id is normally office-assigned (packages/core/src/ref.ts); a
      // job-code-derived placeholder keeps this route usable before that
      // decision is made, same "generate now, correct later" spirit as
      // quotes.ts's JOB-<n> code generation.
      const refId = body.ref_id ?? `REF-${job.code}`;

      try {
        const inserted = await tx.query(
          `insert into ref_document (tenant_id, job_id, ref_id, ficha_fields)
           values ($1, $2, $3, $4)
           returning *;`,
          [tenantId, jobId, refId, JSON.stringify(fichaFields)]
        );
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
      return reply.code(409).send({ error: "ref_already_exists", message: "This job already has a ref_document." });
    if (outcome.kind === "mismatch") return reply.code(422).send(refTermoMismatchError(outcome.message));
    return reply.code(201).send(outcome.row);
  });

  app.patch<{ Params: { id: string } }>("/jobs/:id/ref", async (req, reply) => {
    const body = PatchRefDocumentRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    const outcome = await withTenant(tenantId, async (tx) => {
      if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
        return { kind: "forbidden" as const };
      }

      const existingRows = await tx.query<{
        id: string;
        ficha_fields: FichaFields;
        attachments: string[];
        rotulo_affixed: boolean | null;
      }>(
        `select id, ficha_fields, attachments, rotulo_affixed from ref_document where job_id = $1;`,
        [jobId]
      );
      if (existingRows.rows.length === 0) return { kind: "not_found" as const };
      const existing = existingRows.rows[0];

      // Top-level merge, not a whole-object replace (06-phase3-compliance.md
      // §4): any key present in body.ficha_fields replaces that key's
      // value entirely; keys not present keep their stored value.
      const mergedFichaFields: FichaFields = body.ficha_fields
        ? { ...existing.ficha_fields, ...body.ficha_fields }
        : existing.ficha_fields;

      // attachments is an append, not a replace -- "attaches documents".
      const mergedAttachments = body.attachments
        ? [...new Set([...(existing.attachments ?? []), ...body.attachments])]
        : existing.attachments ?? [];

      // F18 — rotulo_affixed (06-phase3-compliance.md §7): a plain field
      // set, not a merge -- undefined in the request means "leave it as
      // recorded", not "clear it".
      const rotuloAffixed = body.rotulo_affixed !== undefined ? body.rotulo_affixed : existing.rotulo_affixed;

      try {
        const updated = await tx.query(
          `update ref_document set ficha_fields = $1, attachments = $2, rotulo_affixed = $3 where id = $4 returning *;`,
          [JSON.stringify(mergedFichaFields), JSON.stringify(mergedAttachments), rotuloAffixed, existing.id]
        );
        return { kind: "ok" as const, row: updated.rows[0] };
      } catch (err) {
        if (err instanceof Error && REF_TERMO_MISMATCH_REGEX.test(err.message)) {
          return { kind: "mismatch" as const, message: err.message };
        }
        throw err;
      }
    });

    if (outcome.kind === "forbidden") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);
    if (outcome.kind === "not_found") return reply.code(404).send({ error: "ref_document_not_found" });
    if (outcome.kind === "mismatch") return reply.code(422).send(refTermoMismatchError(outcome.message));
    return reply.send(outcome.row);
  });

  app.post<{ Params: { id: string } }>("/jobs/:id/ref/generate-pdf", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const jobId = req.params.id;

    // Read step runs in its own short transaction -- the PDF render
    // (headless Chromium launch + page.pdf()) takes real wall-clock time
    // and has no business happening while a PGlite transaction is held
    // open (PGlite is single-writer, per apps/api/README.md's Phase 2
    // notes on why the proof script spawns a fresh process for the
    // SIGKILL scenario rather than sharing one).
    const readOutcome = await withTenant(tenantId, async (tx) => {
      if ((await tenantComplianceProfile(tx, tenantId)) === "basic") {
        return { kind: "forbidden" as const };
      }
      const rows = await tx.query<{
        id: string;
        ref_id: string;
        ficha_fields: FichaFields;
        created_at: string;
      }>(`select id, ref_id, ficha_fields, created_at from ref_document where job_id = $1;`, [jobId]);
      if (rows.rows.length === 0) return { kind: "not_found" as const };
      return { kind: "ok" as const, ref: rows.rows[0] };
    });

    if (readOutcome.kind === "forbidden") return reply.code(403).send(COMPLIANCE_PROFILE_REQUIRED_ERROR);
    if (readOutcome.kind === "not_found") return reply.code(404).send({ error: "ref_document_not_found" });

    const { ref } = readOutcome;
    const key = crypto.randomUUID();
    await generateRefPdf(objectStore, key, ref.ref_id, new Date(ref.created_at), ref.ficha_fields);

    const writeOutcome = await withTenant(tenantId, async (tx) => {
      const updated = await tx.query(
        `update ref_document set generated_pdf = $1 where id = $2 returning *;`,
        [key, ref.id]
      );
      return updated.rows[0] ? { kind: "ok" as const, row: updated.rows[0] } : { kind: "not_found" as const };
    });

    if (writeOutcome.kind === "not_found") return reply.code(404).send({ error: "ref_document_not_found" });
    return reply.send(writeOutcome.row);
  });
}
