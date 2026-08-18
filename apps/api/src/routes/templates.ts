// 04-API-SPEC.md §2 — the template engine, including the compliance gate
// that's the whole reason ited-ref-mapping.md §7A.3 and seed.sql exist.
// RLS already does the "tenant's own + visible system templates" filtering
// (03-schema.sql §12's bespoke `template` policy) — the route doesn't
// re-implement that filter, it just runs inside withTenant and trusts it,
// same principle as architecture §3.

import type { FastifyInstance } from "fastify";
import {
  CreateTemplateRequest,
  CreateTemplateVersionRequest,
  ActivateTestProtocolRequest,
  TestProtocolBody,
} from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";

const UNVERIFIED_TEST_PROTOCOL_ERROR = {
  error: "unverified_test_protocol",
  message:
    "Cannot activate: numeric limits not yet confirmed against Manual ITED. See ited-ref-mapping.md §7A.3.",
};

export async function templateRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get<{ Querystring: { kind?: string; layer?: string } }>("/templates", async (req, reply) => {
    const { kind, layer } = req.query;
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, tenant_id, layer, kind, code, title, forked_from, created_at
         from template
         where ($1::text is null or kind = $1) and ($2::text is null or layer = $2)
         order by created_at desc;`,
        [kind ?? null, layer ?? null]
      )
    );
    return reply.send({ templates: rows.rows });
  });

  app.post("/templates", async (req, reply) => {
    const body = CreateTemplateRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const created = await withTenant(tenantId, async (tx) => {
      const tpl = await tx.query<{ id: string }>(
        `insert into template (tenant_id, layer, kind, code, title, forked_from)
         values ($1, 'tenant', $2, $3, $4, $5) returning id;`,
        [tenantId, body.kind, body.code, body.title, body.forkedFrom ?? null]
      );
      const templateId = tpl.rows[0].id;

      // Forking (API spec §2): copy the source's active version body into a
      // new tenant-owned draft, version 1.
      if (body.forkedFrom) {
        const source = await tx.query<{ body: unknown }>(
          `select tv.body from template_version tv
           where tv.template_id = $1 and tv.status = 'active'
           order by tv.version desc limit 1;`,
          [body.forkedFrom]
        );
        if (source.rows[0]) {
          await tx.query(
            `insert into template_version (template_id, version, status, body)
             values ($1, 1, 'draft', $2);`,
            [templateId, JSON.stringify(source.rows[0].body)]
          );
        }
      }
      return templateId;
    });

    return reply.code(201).send({ id: created });
  });

  app.get<{ Params: { id: string } }>("/templates/:id/versions", async (req, reply) => {
    const rows = await withTenant(req.auth!.tenant_id, (tx) =>
      tx.query(
        `select id, version, status, body, effective_from, published_at, verified_by, verified_source
         from template_version where template_id = $1 order by version desc;`,
        [req.params.id]
      )
    );
    return reply.send({ versions: rows.rows });
  });

  app.post<{ Params: { id: string } }>("/templates/:id/versions", async (req, reply) => {
    const raw = CreateTemplateVersionRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;

    const result = await withTenant(tenantId, async (tx) => {
      const tpl = await tx.query<{ kind: string }>(`select kind from template where id = $1;`, [
        req.params.id,
      ]);
      if (tpl.rows.length === 0) return { notFound: true as const };

      const body =
        tpl.rows[0].kind === "test_protocol" ? TestProtocolBody.parse(raw.body) : raw.body;

      const nextVersion = await tx.query<{ next: number }>(
        `select coalesce(max(version), 0) + 1 as next from template_version where template_id = $1;`,
        [req.params.id]
      );
      const inserted = await tx.query<{ id: string; version: number }>(
        `insert into template_version (template_id, version, status, body)
         values ($1, $2, 'draft', $3) returning id, version;`,
        [req.params.id, nextVersion.rows[0].next, JSON.stringify(body)]
      );
      return { row: inserted.rows[0] };
    });

    if ("notFound" in result) return reply.code(404).send({ error: "template_not_found" });
    return reply.code(201).send(result.row);
  });

  app.post<{ Params: { id: string; version: string } }>(
    "/templates/:id/versions/:version/activate",
    async (req, reply) => {
      const tenantId = req.auth!.tenant_id;

      const outcome = await withTenant(tenantId, async (tx) => {
        const target = await tx.query<{ id: string; kind: string; verified_by: string | null }>(
          `select tv.id, t.kind, tv.verified_by
           from template_version tv join template t on t.id = tv.template_id
           where tv.template_id = $1 and tv.version = $2;`,
          [req.params.id, Number(req.params.version)]
        );
        if (target.rows.length === 0) return { kind: "not_found" as const };
        const row = target.rows[0];

        let verifiedBy: string | null = null;
        let verifiedSource: string | null = null;
        if (row.kind === "test_protocol") {
          const parsed = ActivateTestProtocolRequest.safeParse(req.body ?? {});
          if (!parsed.success) return { kind: "unverified" as const };
          verifiedBy = parsed.data.verified_by;
          verifiedSource = parsed.data.verified_source;
        }

        // Retire whatever's currently active, then activate this one — the
        // trigger (fn_activate_template_version_guard) is the real
        // enforcement of the test_protocol gate; this check exists to
        // return the clean error shape API spec §2 documents instead of a
        // raw constraint violation.
        try {
          await tx.query(
            `update template_version set status = 'retired'
             where template_id = $1 and status = 'active';`,
            [req.params.id]
          );
          await tx.query(
            `update template_version
             set status = 'active', effective_from = now(),
                 published_at = coalesce(published_at, now()),
                 published_by = coalesce(published_by, $4::uuid),
                 verified_by = coalesce($2::uuid, verified_by),
                 verified_source = coalesce($3, verified_source),
                 verified_at = case when $2::uuid is not null then now() else verified_at end
             where id = $1;`,
            [row.id, verifiedBy, verifiedSource, req.auth!.user_id]
          );
        } catch (err) {
          if (err instanceof Error && /unverified test_protocol/.test(err.message)) {
            return { kind: "unverified" as const };
          }
          throw err;
        }
        return { kind: "ok" as const };
      });

      if (outcome.kind === "not_found") return reply.code(404).send({ error: "version_not_found" });
      if (outcome.kind === "unverified") return reply.code(422).send(UNVERIFIED_TEST_PROTOCOL_ERROR);
      return reply.send({ ok: true });
    }
  );
}
