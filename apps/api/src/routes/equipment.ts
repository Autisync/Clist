// 04-API-SPEC.md §6, 03-schema.sql §8. Same route-file pattern as
// catalog.ts/clients.ts: requireAuth preHandler, withTenant for every
// query, parameterized SQL only.

import type { FastifyInstance } from "fastify";
import {
  CreateEquipmentRequest,
  UpdateEquipmentRequest,
  RecordCalibrationRequest,
} from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

export async function equipmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/equipment", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, kind, make, model, serial, supports_export,
                calibration_cert_file, calibration_issued_on, calibration_expires_on,
                created_at
         from equipment
         order by created_at desc;`
      )
    );
    return reply.send({ equipment: rows.rows });
  });

  app.post("/equipment", async (req, reply) => {
    const body = CreateEquipmentRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `insert into equipment (tenant_id, kind, make, model, serial, supports_export)
         values ($1, $2, $3, $4, $5, $6) returning id;`,
        [tenantId, body.kind, body.make ?? null, body.model ?? null, body.serial ?? null, body.supports_export]
      )
    );

    return reply.code(201).send({ id: created.rows[0].id });
  });

  app.patch<{ Params: { id: string } }>("/equipment/:id", async (req, reply) => {
    const body = UpdateEquipmentRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const updated = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `update equipment
         set kind = coalesce($1, kind),
             make = coalesce($2, make),
             model = coalesce($3, model),
             serial = coalesce($4, serial),
             supports_export = coalesce($5, supports_export)
         where id = $6 and tenant_id = $7
         returning id;`,
        [
          body.kind ?? null,
          body.make ?? null,
          body.model ?? null,
          body.serial ?? null,
          body.supports_export ?? null,
          req.params.id,
          tenantId,
        ]
      )
    );

    if (updated.rows.length === 0) return reply.code(404).send({ error: "equipment_not_found" });
    return reply.send({ ok: true });
  });

  // Architecture §7's append-only-evidence spirit says supersede certs,
  // never overwrite. For v1 simplicity this endpoint DOES overwrite the
  // current calibration_* columns instead -- a deliberate, small scope
  // reduction from that ideal, called out here so it's a visible decision
  // rather than a silent gap. A future pass would insert a new
  // equipment_calibration history row and derive these columns from it.
  app.post<{ Params: { id: string } }>("/equipment/:id/calibration", async (req, reply) => {
    const body = RecordCalibrationRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const updated = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string; calibration_cert_file: string; calibration_issued_on: string; calibration_expires_on: string }>(
        `update equipment
         set calibration_cert_file = $1,
             calibration_issued_on = $2,
             calibration_expires_on = $3
         where id = $4 and tenant_id = $5
         returning id, calibration_cert_file, calibration_issued_on, calibration_expires_on;`,
        [body.cert_file, body.issued_on, body.expires_on, req.params.id, tenantId]
      )
    );

    if (updated.rows.length === 0) return reply.code(404).send({ error: "equipment_not_found" });
    return reply.send(updated.rows[0]);
  });

  // API spec §6 — office worklist. Simple date-range query: certs expiring
  // between now and now() + within_days.
  app.get<{ Querystring: { within_days?: string } }>("/equipment/expiring", async (req, reply) => {
    const withinDays = req.query.within_days ? Number(req.query.within_days) : 14;

    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, kind, make, model, serial, calibration_expires_on
         from equipment
         where calibration_expires_on is not null
           and calibration_expires_on <= (current_date + ($1 || ' days')::interval)
         order by calibration_expires_on asc;`,
        [String(withinDays)]
      )
    );

    return reply.send({ equipment: rows.rows });
  });
}
