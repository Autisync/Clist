// 04-API-SPEC.md §4, 03-schema.sql §6, 05-phase2-job-loop.md §3 (F01/F02).
// "straightforward CRUD against quote/quote_line -- no gate, no snapshot
// logic" per §3. POST /quotes/:id/create-job (the one piece of real domain
// logic, §4) delegates the checklist/execution/test-protocol snapshot
// resolution to domain/job-creation.ts -- this file only owns the HTTP
// shape: load + validate the quote, insert the job row, call the domain
// function inside the same withTenant transaction.
// Same route-file pattern as templates.ts: requireAuth preHandler,
// withTenant for every query, parameterized SQL only.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateQuoteRequest, UpdateQuoteLinesRequest } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { createJobFromQuote } from "../domain/job-creation.js";

export async function quoteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { client_id?: string; status?: string } }>(
    "/quotes",
    async (req, reply) => {
      const { client_id, status } = req.query;
      const rows = await withTenant(req.auth!.tenant_id, (tx) =>
        tx.query(
          `select id, tenant_id, client_id, job_type, quoted_hours, quoted_materials,
                  status, accepted_at, created_by, created_at
           from quote
           where ($1::uuid is null or client_id = $1) and ($2::text is null or status = $2)
           order by created_at desc;`,
          [client_id ?? null, status ?? null]
        )
      );
      return reply.send({ quotes: rows.rows });
    }
  );

  app.post("/quotes", async (req, reply) => {
    const body = CreateQuoteRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `insert into quote (tenant_id, client_id, job_type, quoted_hours, quoted_materials, created_by)
         values ($1, $2, $3, $4, $5, $6) returning id;`,
        [tenantId, body.client_id, body.job_type, body.quoted_hours, body.quoted_materials, req.auth!.user_id]
      )
    );

    return reply.code(201).send({ id: created.rows[0].id });
  });

  // Full replace of the BOM in one call (§3: "simplest correct semantics for
  // v1" -- quote_line has no independent identity clients rely on, so
  // delete-then-reinsert inside the same transaction is fine).
  app.patch<{ Params: { id: string } }>("/quotes/:id/lines", async (req, reply) => {
    const body = UpdateQuoteLinesRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const quoteId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const quote = await tx.query<{ id: string }>(`select id from quote where id = $1;`, [quoteId]);
      if (quote.rows.length === 0) return { kind: "not_found" as const };

      await tx.query(`delete from quote_line where quote_id = $1 and tenant_id = $2;`, [
        quoteId,
        tenantId,
      ]);

      const inserted: { id: string }[] = [];
      for (const line of body.lines) {
        const row = await tx.query<{ id: string }>(
          `insert into quote_line (tenant_id, quote_id, item_id, description, qty, planned_supplier_id, unit_price)
           values ($1, $2, $3, $4, $5, $6, $7) returning id;`,
          [
            tenantId,
            quoteId,
            line.item_id ?? null,
            line.description,
            line.qty,
            line.planned_supplier_id ?? null,
            line.unit_price,
          ]
        );
        inserted.push(row.rows[0]);
      }
      return { kind: "ok" as const, lines: inserted };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "quote_not_found" });
    return reply.send({ lines: result.lines });
  });

  // status draft/sent -> accepted, stamps accepted_at. Job creation is a
  // separate, explicit call (§3) -- not an automatic side effect here.
  app.post<{ Params: { id: string } }>("/quotes/:id/accept", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const quoteId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const current = await tx.query<{ status: string }>(`select status from quote where id = $1;`, [
        quoteId,
      ]);
      if (current.rows.length === 0) return { kind: "not_found" as const };
      if (!["draft", "sent"].includes(current.rows[0].status)) return { kind: "conflict" as const };

      const updated = await tx.query<{ id: string; status: string; accepted_at: string }>(
        `update quote set status = 'accepted', accepted_at = now()
         where id = $1 returning id, status, accepted_at;`,
        [quoteId]
      );
      return { kind: "ok" as const, row: updated.rows[0] };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "quote_not_found" });
    if (result.kind === "conflict")
      return reply.code(409).send({ error: "quote_already_finalized" });
    return reply.send(result.row);
  });

  // The one piece of real domain logic in this file (§4). Materializes a
  // `job` row + job_checklist_item rows from the accepted quote + the
  // tenant's resolved templates. No request body (§3: "also has no request
  // body").
  app.post<{ Params: { id: string } }>("/quotes/:id/create-job", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const quoteId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const quoteRows = await tx.query<{
        client_id: string;
        job_type: string;
        quoted_hours: string;
        quoted_materials: string;
        status: string;
      }>(
        `select client_id, job_type, quoted_hours, quoted_materials, status
         from quote where id = $1;`,
        [quoteId]
      );
      if (quoteRows.rows.length === 0) return { kind: "not_found" as const };
      const quote = quoteRows.rows[0];
      if (quote.status !== "accepted") return { kind: "not_accepted" as const };

      // JOB-<4-digit>, collision-safe under the tenant's unique(tenant_id,
      // code) constraint. Check-then-insert rather than catch-and-retry on
      // a constraint violation: a failed statement aborts the rest of this
      // transaction in Postgres (PGlite included), so retrying more inserts
      // after catching one isn't safe here the way it would be in a fresh
      // transaction per attempt.
      let code: string | null = null;
      for (let attempt = 0; attempt < 20 && !code; attempt++) {
        const candidate = `JOB-${crypto.randomInt(1000, 10000)}`;
        const existing = await tx.query(
          `select 1 from job where tenant_id = $1 and code = $2;`,
          [tenantId, candidate]
        );
        if (existing.rows.length === 0) code = candidate;
      }
      if (!code) return { kind: "code_collision" as const };

      const inserted = await tx.query<{ id: string }>(
        `insert into job (tenant_id, quote_id, client_id, code, title, job_type, quoted_hours, quoted_materials)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id;`,
        [
          tenantId,
          quoteId,
          quote.client_id,
          code,
          quote.job_type,
          quote.job_type,
          quote.quoted_hours,
          quote.quoted_materials,
        ]
      );
      const jobId = inserted.rows[0].id;

      const summary = await createJobFromQuote({
        tx,
        tenantId,
        jobId,
        quoteId,
        jobType: quote.job_type,
      });

      return { kind: "ok" as const, jobId, code, summary };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "quote_not_found" });
    if (result.kind === "not_accepted") return reply.code(409).send({ error: "quote_not_accepted" });
    if (result.kind === "code_collision") return reply.code(500).send({ error: "job_code_collision" });
    return reply.code(201).send({
      id: result.jobId,
      code: result.code,
      checklist: result.summary.checklist,
      has_execution_snapshot: result.summary.has_execution_snapshot,
      has_test_protocol_snapshot: result.summary.has_test_protocol_snapshot,
    });
  });
}
