// 04-API-SPEC.md §3, 03-schema.sql §5, 07-phase4-cost-intelligence.md §3/§4.
// requireAuth preHandler, parameterized SQL only, tenant_id always from
// req.auth, never the client.
//
// Every route in this file uses withPublicSchema, not withTenant — real
// bug, found and fixed the same session the office "create supplier" UI
// first made it reachable: supplier/supplier_price/catalog_item all have
// two copies in this project (the classic system's own, and the real,
// Supabase-native public.* ones apps/web actually reads/writes via
// Supabase directly). withTenant queried the classic copy exclusively,
// completely disconnected from every real supplier a tenant could
// actually see or create. withPublicSchema bypasses RLS (same trusted
// connection withMigrator/technicians.ts already use for this exact class
// of problem), so tenant_id is checked explicitly in every query below
// rather than relying on RLS to scope it.

import type { FastifyInstance } from "fastify";
import {
  CreateSupplierRequest,
  UpdateSupplierRequest,
  RecordSupplierPriceRequest,
} from "@fieldready/core";
import { withPublicSchema } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { placesProvider, PlacesApiError, type PlacesRefreshResult } from "../places-provider.js";

export async function supplierRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/suppliers", async (req, reply) => {
    const rows = await withPublicSchema((db) =>
      db.query(
        `select id, tenant_id, name, category, address, phone, account_note,
                place_id, distance_km, synced_at, hours, created_at
         from public.supplier
         where tenant_id = $1
         order by name asc;`,
        [req.auth!.tenant_id]
      )
    );
    return reply.send({ suppliers: rows.rows });
  });

  app.post("/suppliers", async (req, reply) => {
    const body = CreateSupplierRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withPublicSchema((db) =>
      db.query<{ id: string }>(
        `insert into public.supplier (tenant_id, name, category, address, phone, account_note,
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

    const updated = await withPublicSchema((db) =>
      db.query<{ id: string }>(
        `update public.supplier
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
  // configured PlacesProvider (fixture-backed without a real API key,
  // real Google Places API (New) once GOOGLE_PLACES_API_KEY is set —
  // places-provider.ts) and bumps synced_at, same "refresh from an
  // external source of record" shape as any future real integration
  // would have.
  //
  // Split into two withPublicSchema calls (read, then write) with the
  // Places call sandwiched in between OUTSIDE either transaction — a slow
  // or failed third-party call must never hold a DB connection/transaction
  // open, same reasoning as routes/receipts.ts's own OCR call being
  // deliberately outside its withTenant block.
  //
  // withPublicSchema, not withTenant — real bug, found and fixed the same
  // session the office "create supplier" UI first made it reachable: the
  // office suppliers page (apps/web) reads/writes `public.supplier`
  // directly via Supabase (§6 Step 5's migration), a COMPLETELY SEPARATE
  // table from this classic system's own `supplier` (03-schema.sql,
  // whatever this connection's search_path normally resolves to —
  // FASTIFY_DB_SCHEMA, db.ts). withTenant here was silently 404ing
  // "supplier_not_found" for every real, Supabase-native supplier, since
  // it was querying the wrong table entirely — dormant until a supplier
  // could actually be created through the real UI, which is exactly what
  // exposed it. withPublicSchema bypasses RLS (same trusted connection
  // withMigrator/technicians.ts already use for this exact class of
  // problem), so tenant_id is now checked explicitly in both queries
  // below rather than relying on RLS to scope them.
  app.post<{ Params: { id: string } }>("/suppliers/:id/refresh-places", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const found = await withPublicSchema((db) =>
      db.query<{ id: string; place_id: string | null }>(
        `select id, place_id from public.supplier where id = $1 and tenant_id = $2;`,
        [req.params.id, tenantId]
      )
    );
    if (found.rows.length === 0) return reply.code(404).send({ error: "supplier_not_found" });
    const supplier = found.rows[0];
    if (!supplier.place_id)
      return reply.code(422).send({
        error: "no_place_id",
        message: "This supplier has no place_id to refresh against.",
      });

    let refreshed: PlacesRefreshResult;
    try {
      refreshed = await placesProvider.refresh(supplier.place_id);
    } catch (err) {
      if (!(err instanceof PlacesApiError)) throw err; // a real bug, not a vendor failure — surface it normally
      req.log?.warn?.({ err }, "places provider failed; leaving supplier address/phone/hours unchanged");
      refreshed = { address: null, phone: null, hours: null };
    }

    const updated = await withPublicSchema((db) =>
      db.query(
        `update public.supplier
         set address = coalesce($1, address),
             phone = coalesce($2, phone),
             hours = coalesce($3, hours),
             synced_at = now()
         where id = $4 and tenant_id = $5
         returning id, tenant_id, name, category, address, phone, account_note,
                   place_id, distance_km, synced_at, hours, created_at;`,
        [
          refreshed.address,
          refreshed.phone,
          refreshed.hours !== null ? JSON.stringify(refreshed.hours) : null,
          supplier.id,
          tenantId,
        ]
      )
    );
    return reply.send(updated.rows[0]);
  });

  app.get<{ Params: { id: string } }>("/suppliers/:id/prices", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const rows = await withPublicSchema((db) =>
      db.query(
        `select sp.id, sp.tenant_id, sp.supplier_id, sp.item_id, sp.price, sp.prev_price,
                sp.source, sp.effective_at, sp.receipt_id, sp.created_by,
                ci.sku as item_sku, ci.name as item_name, ci.unit as item_unit
         from public.supplier_price sp
         join public.catalog_item ci on ci.id = sp.item_id
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

    const outcome = await withPublicSchema(async (db) => {
      const supplierRows = await db.query<{ id: string }>(
        `select id from public.supplier where id = $1 and tenant_id = $2;`,
        [supplierId, tenantId]
      );
      if (supplierRows.rows.length === 0) return { kind: "supplier_not_found" as const };

      const existingRows = await db.query<{ id: string; price: string }>(
        `select id, price from public.supplier_price
         where tenant_id = $1 and supplier_id = $2 and item_id = $3
         order by effective_at desc
         limit 1;`,
        [tenantId, supplierId, body.item_id]
      );

      let row;
      if (existingRows.rows.length > 0) {
        const existing = existingRows.rows[0];
        const result = await db.query(
          `update public.supplier_price
           set prev_price = $1, price = $2, source = 'manual', effective_at = now(),
               receipt_id = null, created_by = $3
           where id = $4
           returning *;`,
          [existing.price, body.price, userId, existing.id]
        );
        row = result.rows[0];
      } else {
        const result = await db.query(
          `insert into public.supplier_price (tenant_id, supplier_id, item_id, price, prev_price,
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
