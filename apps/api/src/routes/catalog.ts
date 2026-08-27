// 04-API-SPEC.md §3, 03-schema.sql §5. Trivial CRUD — build-order step 1
// (05-phase2-job-loop.md §2): "unblocks everything else's fixtures", no
// gate, no snapshot logic. Same shape as templates.ts: requireAuth
// preHandler, parameterized SQL only.
//
// withPublicSchema, not withTenant — same class of real bug found and
// fixed in suppliers.ts/receipts.ts the same session: catalog_item has
// two copies (the classic system's own, and the real, Supabase-native
// public.catalog_item apps/web's suppliers page actually reads via
// Supabase directly), and GET /catalog-items/:id/sourcing's whole reason
// to exist — ranking REAL supplier prices — only means anything against
// the real one. withPublicSchema bypasses RLS (same trusted connection
// technicians.ts/receipts.ts already use for this), so tenant_id is
// checked explicitly rather than relying on RLS.

import type { FastifyInstance } from "fastify";
import { CreateCatalogItemRequest } from "@fieldready/core";
import { withPublicSchema } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { sourcingOptions } from "../domain/sourcing.js";

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/catalog-items", async (req, reply) => {
    const rows = await withPublicSchema((db) =>
      db.query(
        `select id, tenant_id, sku, name, unit, created_at
         from public.catalog_item
         where tenant_id = $1
         order by name asc;`,
        [req.auth!.tenant_id]
      )
    );
    return reply.send({ catalog_items: rows.rows });
  });

  app.post("/catalog-items", async (req, reply) => {
    const body = CreateCatalogItemRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withPublicSchema((db) =>
      db.query<{ id: string }>(
        `insert into public.catalog_item (tenant_id, sku, name, unit)
         values ($1, $2, $3, $4) returning id;`,
        [tenantId, body.sku, body.name, body.unit]
      )
    );

    return reply.code(201).send({ id: created.rows[0].id });
  });

  // 04-API-SPEC.md §3, 07-phase4-cost-intelligence.md §4: ranked supplier
  // options for one catalog item, sorted by price ascending only (the
  // prototype's sourcingOptions, ~line 269) -- distinct from the
  // coverage/open-now/price tuple GET /jobs/:id/pickup-plan uses.
  app.get<{ Params: { id: string } }>("/catalog-items/:id/sourcing", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const result = await withPublicSchema(async (db) => {
      const itemRows = await db.query(
        `select id from public.catalog_item where id = $1 and tenant_id = $2;`,
        [req.params.id, tenantId]
      );
      if (itemRows.rows.length === 0) return { kind: "not_found" as const };

      const options = await sourcingOptions(db, tenantId, req.params.id);
      return { kind: "ok" as const, options };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "catalog_item_not_found" });
    return reply.send({ options: result.options });
  });
}
