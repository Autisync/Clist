// 04-API-SPEC.md §9 / architecture §4 (Option B). This is the endpoint
// Phase 1 exists to prove: a mutation queued offline, submitted (possibly
// more than once, if the app was killed mid-sync and retries the same
// batch on restart) applies exactly once, keyed on client_mutation_id.
//
// Registered mutation types: exactly one, per architecture §8 ("carrying
// nothing but a trivial ping mutation ... no job domain logic yet").
// checklist_item.update is that trivial mutation — a single-column status
// toggle — using the API spec's own illustrative shape rather than a
// throwaway one, so Phase 2 can register more handlers into this same
// table/switch without changing the envelope.

import type { FastifyInstance } from "fastify";
import { SyncMutationsRequest, type SyncMutationResult } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/sync/mutations", async (req, reply) => {
    const { mutations } = SyncMutationsRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const results: SyncMutationResult[] = await withTenant(tenantId, async (tx) => {
      // applied_mutation is a real, RLS-covered table (03-schema.sql §11a) —
      // fieldready_app has exactly select/insert/update/delete on it, not
      // CREATE, so it's provisioned by the schema/migration, never lazily
      // here.
      const out: SyncMutationResult[] = [];
      for (const m of mutations) {
        const already = await tx.query<{ result: SyncMutationResult }>(
          `select result from applied_mutation where client_mutation_id = $1 and tenant_id = $2;`,
          [m.client_mutation_id, tenantId]
        );
        if (already.rows[0]) {
          out.push({ ...already.rows[0].result, status: "already_applied" });
          continue;
        }

        // The one Phase 1 mutation handler.
        if (m.type === "checklist_item.update") {
          const updated = await tx.query<{ id: string }>(
            `update job_checklist_item
             set status = $1
             where id = $2 and tenant_id = $3 and job_id = $4
             returning id;`,
            [m.payload.status, m.payload.item_id, tenantId, m.job_id]
          );
          const result: SyncMutationResult =
            updated.rows.length > 0
              ? { client_mutation_id: m.client_mutation_id, status: "applied" }
              : { client_mutation_id: m.client_mutation_id, status: "rejected", reason: "item_not_found" };

          await tx.query(
            `insert into applied_mutation (client_mutation_id, tenant_id, mutation_type, result)
             values ($1, $2, $3, $4);`,
            [m.client_mutation_id, tenantId, m.type, JSON.stringify(result)]
          );
          out.push(result);
        } else {
          out.push({ client_mutation_id: m.client_mutation_id, status: "rejected", reason: "unknown_mutation_type" });
        }
      }
      return out;
    });

    return reply.send({ results });
  });

  // Download direction (API spec §9) — stubbed to the shape Phase 2 needs
  // without the job-snapshot resolution logic behind it yet.
  app.get("/sync/bootstrap", async (req, reply) => {
    return reply.send({ cursor: new Date().toISOString(), jobs: [], van_audits: [], equipment: [] });
  });

  // Proof-only, not in API spec: an independent read path so
  // test/phase1-proof.ts can confirm a mutation's effect landed, through
  // the real HTTP surface rather than reaching into PGlite's on-disk files
  // from a second process (which PGlite, single-writer by design, doesn't
  // support safely). Same auth+RLS as everything else — not a bypass, just
  // narrow. Fine to delete once Phase 2 adds a real GET /jobs/:id/readiness.
  app.get<{ Params: { id: string } }>("/sync/_debug/checklist-item/:id", async (req, reply) => {
    const row = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(`select id, status from job_checklist_item where id = $1;`, [req.params.id])
    );
    if (row.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    return reply.send(row.rows[0]);
  });
}
