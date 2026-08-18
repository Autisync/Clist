// 04-API-SPEC.md §4, 03-schema.sql §6. Trivial CRUD, same build-order note
// as catalog.ts (05-phase2-job-loop.md §2 step 1). Same route-file pattern
// as templates.ts: requireAuth preHandler, withTenant for every query,
// parameterized SQL only.

import type { FastifyInstance } from "fastify";
import { CreateClientRequest, UpdateClientRequest } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/clients", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, name, address, phone, email, created_at
         from client
         order by name asc;`
      )
    );
    return reply.send({ clients: rows.rows });
  });

  app.post("/clients", async (req, reply) => {
    const body = CreateClientRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `insert into client (tenant_id, name, address, phone, email)
         values ($1, $2, $3, $4, $5) returning id;`,
        [tenantId, body.name, body.address ?? null, body.phone ?? null, body.email ?? null]
      )
    );

    return reply.code(201).send({ id: created.rows[0].id });
  });

  app.patch<{ Params: { id: string } }>("/clients/:id", async (req, reply) => {
    const body = UpdateClientRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const updated = await withTenant(tenantId, (tx) =>
      tx.query<{ id: string }>(
        `update client
         set name = coalesce($1, name),
             address = coalesce($2, address),
             phone = coalesce($3, phone),
             email = coalesce($4, email)
         where id = $5 and tenant_id = $6
         returning id;`,
        [
          body.name ?? null,
          body.address ?? null,
          body.phone ?? null,
          body.email ?? null,
          req.params.id,
          tenantId,
        ]
      )
    );

    if (updated.rows.length === 0) return reply.code(404).send({ error: "client_not_found" });
    return reply.send({ ok: true });
  });
}
