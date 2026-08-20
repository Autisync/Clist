// 04-API-SPEC.md §3, 03-schema.sql §5, 07-phase4-cost-intelligence.md §5.
// Same route-file pattern as suppliers.ts/jobs.ts: requireAuth preHandler,
// withTenant for every query, parameterized SQL only, tenant_id always from
// req.auth, never the client. Multipart handling (metadata fields + one
// file part) mirrors POST /jobs/:id/photos in jobs.ts exactly.
//
// The one rule this whole file exists to enforce (04-API-SPEC.md §3,
// non-negotiable): OCR output is NEVER written to supplier_price directly.
// POST /receipts writes receipt + receipt_line rows only. POST
// /receipts/:id/confirm -- a human action -- is the only place a
// supplier_price row gets written from OCR-derived data, and only for the
// line_ids the human actually confirmed.

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { CreateReceiptRequest, ConfirmReceiptLinesRequest } from "@fieldready/core";
import { withTenant } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { objectStore } from "../object-store.js";
import { receiptOcrProvider, ReceiptOcrError, type ReceiptOcrResult } from "../receipt-ocr-provider.js";

export async function receiptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/receipts", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const data = await req.file();
    if (!data) {
      return reply.code(400).send({ error: "no_file", message: "Expected a multipart file part." });
    }

    const fieldValue = (name: string): unknown => {
      const field = data.fields[name];
      if (!field || Array.isArray(field) || field.type !== "field") return undefined;
      return field.value;
    };

    const metadata = CreateReceiptRequest.parse({
      supplier_id: fieldValue("supplier_id") || undefined,
      doc_number: fieldValue("doc_number") || undefined,
      receipt_date: fieldValue("receipt_date") || undefined,
    });

    const buffer = await data.toBuffer();
    const key = crypto.randomUUID();
    await objectStore.put(key, buffer);

    // Vendor OCR call (receipt-ocr-provider.ts) -- deliberately outside the
    // withTenant transaction below (a slow/failed third-party call must
    // never hold a DB transaction open) and explicitly guarded: the receipt
    // image is already durably stored (objectStore.put above) by this
    // point, so a Veryfi outage or timeout must degrade to "receipt saved,
    // zero parsed lines, office fills in manually" -- never a 500 that
    // loses the upload entirely. Uptime of receipt capture must not depend
    // on a third-party vendor's uptime.
    let ocrResult: ReceiptOcrResult;
    let ocrFailed = false;
    try {
      ocrResult = await receiptOcrProvider.parse(buffer);
    } catch (err) {
      if (!(err instanceof ReceiptOcrError)) throw err; // a real bug, not a vendor failure -- surface it normally
      req.log?.warn?.({ err }, "receipt OCR provider failed; saving receipt with zero parsed lines");
      ocrFailed = true;
      ocrResult = { lines: [] };
    }

    const result = await withTenant(tenantId, async (tx) => {
      if (metadata.supplier_id) {
        const supplierRows = await tx.query(
          `select id from supplier where id = $1 and tenant_id = $2;`,
          [metadata.supplier_id, tenantId]
        );
        if (supplierRows.rows.length === 0) return { kind: "supplier_not_found" as const };
      }

      const receiptRows = await tx.query<{ id: string }>(
        `insert into receipt (tenant_id, supplier_id, doc_number, receipt_date, image_file, ocr_raw, status)
         values ($1, $2, $3, $4, $5, $6, 'pending')
         returning id;`,
        [
          tenantId,
          metadata.supplier_id ?? null,
          metadata.doc_number ?? ocrResult.doc_number ?? null,
          metadata.receipt_date ?? ocrResult.receipt_date ?? null,
          key,
          // ocr_raw is "kept for audit" (03-schema.sql §5's own comment) --
          // a failure is exactly the kind of thing that belongs in an audit
          // trail, so it's recorded here rather than only logged and lost.
          JSON.stringify(ocrFailed ? { ocr_failed: true } : ocrResult),
        ]
      );
      const receiptId = receiptRows.rows[0].id;

      const lines = [] as unknown[];
      for (const line of ocrResult.lines) {
        // "sem correspondência" case: a description that doesn't exactly
        // match an existing catalog_item by name or sku (case-insensitive)
        // is inserted with item_id = null for office review, not dropped
        // and not guessed at.
        const matchRows = await tx.query<{ id: string }>(
          `select id from catalog_item
           where tenant_id = $1 and (lower(name) = lower($2) or lower(sku) = lower($2))
           limit 1;`,
          [tenantId, line.description]
        );
        const itemId = matchRows.rows[0]?.id ?? null;

        const inserted = await tx.query(
          `insert into receipt_line (tenant_id, receipt_id, item_id, description, qty, unit_price)
           values ($1, $2, $3, $4, $5, $6)
           returning id, tenant_id, receipt_id, item_id, description, qty, unit_price;`,
          [tenantId, receiptId, itemId, line.description, line.qty, line.unit_price]
        );
        lines.push(inserted.rows[0]);
      }

      return { kind: "ok" as const, receiptId, lines };
    });

    if (result.kind === "supplier_not_found") return reply.code(404).send({ error: "supplier_not_found" });
    return reply.code(201).send({ id: result.receiptId, lines: result.lines, ocr_failed: ocrFailed });
  });

  app.get<{ Params: { id: string } }>("/receipts/:id", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const result = await withTenant(tenantId, async (tx) => {
      const receiptRows = await tx.query(
        `select id, tenant_id, supplier_id, doc_number, receipt_date, image_file, ocr_raw,
                status, confirmed_by, confirmed_at, created_at
         from receipt
         where id = $1 and tenant_id = $2;`,
        [req.params.id, tenantId]
      );
      if (receiptRows.rows.length === 0) return { kind: "not_found" as const };

      const lineRows = await tx.query(
        `select id, tenant_id, receipt_id, item_id, description, qty, unit_price
         from receipt_line
         where receipt_id = $1 and tenant_id = $2
         order by description asc;`,
        [req.params.id, tenantId]
      );

      return { kind: "ok" as const, receipt: receiptRows.rows[0], lines: lineRows.rows };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "receipt_not_found" });
    return reply.send({ ...result.receipt, lines: result.lines });
  });

  // The human-in-the-loop step (04-API-SPEC.md §3): writes supplier_price
  // only for the confirmed line_ids that also have a matched item_id.
  // Unconfirmed lines, and confirmed lines with no item_id match, are left
  // alone entirely -- genuinely selective, not all-or-nothing.
  app.post<{ Params: { id: string } }>("/receipts/:id/confirm", async (req, reply) => {
    const body = ConfirmReceiptLinesRequest.parse(req.body);
    const tenantId = req.auth!.tenant_id;
    const userId = req.auth!.user_id;
    const receiptId = req.params.id;

    const result = await withTenant(tenantId, async (tx) => {
      const receiptRows = await tx.query<{ id: string; supplier_id: string | null }>(
        `select id, supplier_id from receipt where id = $1 and tenant_id = $2;`,
        [receiptId, tenantId]
      );
      if (receiptRows.rows.length === 0) return { kind: "not_found" as const };
      const receipt = receiptRows.rows[0];

      const lineRows = await tx.query<{
        id: string;
        item_id: string | null;
        unit_price: string;
      }>(
        `select id, item_id, unit_price
         from receipt_line
         where receipt_id = $1 and tenant_id = $2 and id = any($3::uuid[]);`,
        [receiptId, tenantId, body.line_ids]
      );

      const confirmedPrices: unknown[] = [];
      for (const line of lineRows.rows) {
        if (!line.item_id) continue; // "sem correspondência" -- nothing to price
        if (!receipt.supplier_id) continue; // no supplier on this receipt -- can't attribute a price

        // Same "one current row per (tenant, supplier, item)" invariant
        // POST /suppliers/:id/prices maintains (suppliers.ts, and
        // domain/sourcing.ts's comment lines 108-110 relies on): overwrite
        // the existing row in place rather than inserting a new one, so
        // repeat receipt-confirmations for the same supplier+item don't
        // accumulate duplicate "current" rows.
        const existingRows = await tx.query<{ id: string; price: string }>(
          `select id, price from supplier_price
           where tenant_id = $1 and supplier_id = $2 and item_id = $3
           order by effective_at desc
           limit 1;`,
          [tenantId, receipt.supplier_id, line.item_id]
        );

        let row;
        if (existingRows.rows.length > 0) {
          const existing = existingRows.rows[0];
          const updated = await tx.query(
            `update supplier_price
             set prev_price = $1, price = $2, source = 'receipt', effective_at = now(),
                 receipt_id = $3, created_by = $4
             where id = $5
             returning *;`,
            [existing.price, line.unit_price, receiptId, userId, existing.id]
          );
          row = updated.rows[0];
        } else {
          const inserted = await tx.query(
            `insert into supplier_price (tenant_id, supplier_id, item_id, price, prev_price,
                                          source, receipt_id, created_by)
             values ($1, $2, $3, $4, null, 'receipt', $5, $6)
             returning *;`,
            [tenantId, receipt.supplier_id, line.item_id, line.unit_price, receiptId, userId]
          );
          row = inserted.rows[0];
        }
        confirmedPrices.push(row);
      }

      await tx.query(
        `update receipt set status = 'confirmed', confirmed_by = $1, confirmed_at = now()
         where id = $2;`,
        [userId, receiptId]
      );

      return { kind: "ok" as const, confirmedPrices };
    });

    if (result.kind === "not_found") return reply.code(404).send({ error: "receipt_not_found" });
    return reply.send({ ok: true, supplier_prices: result.confirmedPrices });
  });
}
