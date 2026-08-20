// 04-API-SPEC.md §3, 03-schema.sql §5, 07-phase4-cost-intelligence.md §3/§4.
// Same route-file pattern as catalog.ts/clients.ts/equipment.ts:
// requireAuth preHandler, withTenant for every query, parameterized SQL
// only, tenant_id always from req.auth, never the client.

import type { FastifyInstance } from "fastify";
import {
  CreateSupplierRequest,
  UpdateSupplierRequest,
  RecordSupplierPriceRequest,
} from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { placesProvider } from "../places-provider.js";

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/suppliers", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, name, category, address, phone, account_note,
                place_id, distance_km, synced_at, hours, created_at
         from supplier
         order by name asc;`
      )
    );
    return reply.send({ suppliers: rows.rows });
  });

  app.post("/suppliers", async (req, reply) => {
    const body = CreateSupplierRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `insert into supplier (tenant_id, name, category, address, phone, account_note,
                                place_id, distance_km, hours)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id;`,
        [
          tenantId,
          body.name,
          body.category ?? null,
          body.address ?? null,
          body.phone ?? null,
          body.account_note ?? null,
          body.place_id ?? null,
          body.distance_km ?? null,
          body.hours !== undefined ? JSON.stringify(body.hours) : null,
        ]
      )
    );

    return reply.code(201).send({ id: created.rows[0].id });
  });

  app.patch<{ Params: { id: string } }>("/suppliers/:id", async (req, reply) => {
    const body = UpdateSupplierRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const updated = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `update supplier
         set name = coalesce($1, name),
             category = coalesce($2, category),
             address = coalesce($3, address),
             phone = coalesce($4, phone),
             account_note = coalesce($5, account_note),
             place_id = coalesce($6, place_id),
             distance_km = coalesce($7, distance_km),
             hours = coalesce($8, hours)
         where id = $9 and tenant_id = $10
         returning id;`,
        [
          body.name ?? null,
          body.category ?? null,
          body.address ?? null,
          body.phone ?? null,
          body.account_note ?? null,
          body.place_id ?? null,
          body.distance_km ?? null,
          body.hours !== undefined ? JSON.stringify(body.hours) : null,
          req.params.id,
          tenantId,
        ]
      )
    );

    if (updated.rows.length === 0) return reply.code(404).send({ error: "supplier_not_found" });
    return reply.send({ ok: true });
  });

  // 07-phase4-cost-intelligence.md §3: pulls hours/address/phone from the
  // configured PlacesProvider (fixture-backed in this environment, real
  // Google Places at deploy time — places-provider.ts) and bumps synced_at,
  // same "refresh from an external source of record" shape as any future
  // real integration would have.
  app.post<{ Params: { id: string } }>("/suppliers/:id/refresh-places", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const outcome = await withTenant(tenantId, async (tx) => {
      const rows = await tx.query<{ id: string; place_id: string | null }>(
        `select id, place_id from supplier where id = $1 and tenant_id = $2;`,
        [req.params.id, tenantId]
      );
      if (rows.rows.length === 0) return { kind: "not_found" as const };
      const supplier = rows.rows[0];
      if (!supplier.place_id) return { kind: "no_place_id" as const };

      const refreshed = await placesProvider.refresh(supplier.place_id);

      const updated = await tx.query(
        `update supplier
         set address = coalesce($1, address),
             phone = coalesce($2, phone),
             hours = coalesce($3, hours),
             synced_at = now()
         where id = $4
         returning id, tenant_id, name, category, address, phone, account_note,
                   place_id, distance_km, synced_at, hours, created_at;`,
        [
          refreshed.address,
          refreshed.phone,
          refreshed.hours !== null ? JSON.stringify(refreshed.hours) : null,
          supplier.id,
        ]
      );
      return { kind: "ok" as const, row: updated.rows[0] };
    });

    if (outcome.kind === "not_found") return reply.code(404).send({ error: "supplier_not_found" });
    if (outcome.kind === "no_place_id")
      return reply.code(422).send({
        error: "no_place_id",
        message: "This supplier has no place_id to refresh against.",
      });
    return reply.send(outcome.row);
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id/prices", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const rows = await withTenant(tenantId, (tx) =>
      tx.query(
        `select sp.id, sp.tenant_id, sp.supplier_id, sp.item_id, sp.price, sp.prev_price,
                sp.source, sp.effective_at, sp.receipt_id, sp.created_by,
                ci.sku as item_sku, ci.name as item_name, ci.unit as item_unit
         from supplier_price sp
         join catalog_item ci on ci.id = sp.item_id
         where sp.supplier_id = $1 and sp.tenant_id = $2
         order by ci.name asc;`,
        [req.params.id, tenantId]
      )
    );
    return reply.send({ prices: rows.rows });
  });

  // Direct manual price entry (04-API-SPEC.md §3, 07-phase4-cost-intelligence.md
  // §3). source is always "manual" on this route regardless of what the
  // request body says -- "receipt" source only ever comes from the human
  // POST /receipts/:id/confirm step (§5), never here. supplier_price holds
  // one current row per (tenant, supplier, item): on write, prev_price is
  // set to whatever price was current a moment ago before it's overwritten,
  // same "overwrite, not supersede" v1 scope call apps/api/README.md
  // already names for equipment calibration (05-phase2-job-loop.md).
  app.post<{ Params: { id: string } }>("/suppliers/:id/prices", async (req, reply) => {
    const body = RecordSupplierPriceRequest.parse(req.body);
    if (body.source !== "manual") {
      return reply.code(400).send({
        error: "invalid_source",
        message: "POST /suppliers/:id/prices only accepts source \"manual\" -- receipt-sourced prices are written by POST /receipts/:id/confirm.",
      });
    }
    const tenantId = req.auth!.tenant_id;
    const supplierId = req.params.id;
    const userId = req.auth!.user_id;

    const outcome = await withTenant(tenantId, async (tx) => {
      const supplierRows = await tx.query<{ id: string }>(
        `select id from supplier where id = $1 and tenant_id = $2;`,
        [supplierId, tenantId]
      );
      if (supplierRows.rows.length === 0) return { kind: "supplier_not_found" as const };

      const existingRows = await tx.query<{ id: string; price: string }>(
        `select id, price from supplier_price
         where tenant_id = $1 and supplier_id = $2 and item_id = $3
         order by effective_at desc
         limit 1;`,
        [tenantId, supplierId, body.item_id]
      );

      let row;
      if (existingRows.rows.length > 0) {
        const existing = existingRows.rows[0];
        const result = await tx.query(
          `update supplier_price
           set prev_price = $1, price = $2, source = 'manual', effective_at = now(),
               receipt_id = null, created_by = $3
           where id = $4
           returning *;`,
          [existing.price, body.price, userId, existing.id]
        );
        row = result.rows[0];
      } else {
        const result = await tx.query(
          `insert into supplier_price (tenant_id, supplier_id, item_id, price, prev_price,
                                        source, created_by)
           values ($1, $2, $3, $4, null, 'manual', $5)
           returning *;`,
          [tenantId, supplierId, body.item_id, body.price, userId]
        );
        row = result.rows[0];
      }
      return { kind: "ok" as const, row };
    });

    if (outcome.kind === "supplier_not_found") return reply.code(404).send({ error: "supplier_not_found" });
    return reply.code(201).send(outcome.row);
  });
}
