// 04-API-SPEC.md §8, 07-phase4-cost-intelligence.md §1-2. Thin read layer
// over the v_* views 03-schema.sql §13/§13a already ships -- "if a number
// needs to change, it changes in 03-schema.sql, not in two places" (API
// spec §8's own words). Only /dashboard/price-alerts adds a join (to
// catalog_item/supplier for display names, and to domain/sourcing.ts's
// sourcingOptions for the cheapest alternative supplier -- exactly what
// fieldready-prototype.jsx's priceAlerts, line 455, does client-side today)
// and only /dashboard/recommended-actions adds application logic, and even
// there the arithmetic itself (rework_pct, avg_pct_variance, delta_pct)
// stays in the views; this file only turns real numbers into sentences,
// same split the prototype's static list (line ~583) implies once made
// real.

import type { FastifyInstance } from "fastify";
import { withTenant, type PGliteTx } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { sourcingOptions } from "../domain/sourcing.js";

type FirstTimeFixRow = {
  tenant_id: string;
  month: string;
  jobs_closed: number | string;
  first_time_fixes: number | string;
  ffr_pct: number | string | null;
};

type HoursVarianceRow = {
  tenant_id: string;
  job_type: string;
  n: number | string;
  avg_hours_delta: number | string | null;
  avg_pct_variance: number | string | null;
};

type ReadinessCorrelationRow = {
  tenant_id: string;
  readiness_bucket: "gated" | "ungated";
  jobs: number | string;
  rework_jobs: number | string;
  rework_pct: number | string | null;
};

type PriceAlertRow = {
  tenant_id: string;
  item_id: string;
  supplier_id: string;
  price: string;
  prev_price: string;
  delta_pct: string;
};

const num = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // GET /dashboard/first-time-fix-rate?months=6 -- v_first_time_fix_rate,
  // filtered to the last N months (default 6, per API spec §8's own
  // example query string).
  app.get<{ Querystring: { months?: string } }>(
    "/dashboard/first-time-fix-rate",
    async (req, reply) => {
      const tenantId = req.auth!.tenant_id;
      const monthsParam = Number(req.query.months);
      const months = Number.isFinite(monthsParam) && monthsParam > 0 ? Math.floor(monthsParam) : 6;

      const rows = await withTenant(tenantId, (tx) =>
        tx.query<FirstTimeFixRow>(
          `select tenant_id, month, jobs_closed, first_time_fixes, ffr_pct
           from v_first_time_fix_rate
           where tenant_id = $1
             and month >= date_trunc('month', now()) - ($2 - 1) * interval '1 month'
           order by month asc;`,
          [tenantId, months]
        )
      );

      return reply.send({
        months: rows.rows.map((r) => ({
          month: r.month,
          jobs_closed: num(r.jobs_closed),
          first_time_fixes: num(r.first_time_fixes),
          ffr_pct: num(r.ffr_pct),
        })),
      });
    }
  );

  // GET /dashboard/hours-variance?by=job_type -- v_hours_variance is
  // already grouped by job_type (its only supported grouping today; the
  // querystring exists per API spec §8's exact signature and is validated
  // rather than silently ignored).
  app.get<{ Querystring: { by?: string } }>("/dashboard/hours-variance", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;
    const by = req.query.by ?? "job_type";
    if (by !== "job_type") {
      return reply.code(400).send({
        error: "unsupported_grouping",
        message: `v_hours_variance only supports by=job_type, got "${by}".`,
      });
    }

    const rows = await withTenant(tenantId, (tx) =>
      tx.query<HoursVarianceRow>(
        `select tenant_id, job_type, n, avg_hours_delta, avg_pct_variance
         from v_hours_variance
         where tenant_id = $1
         order by avg_pct_variance desc nulls last;`,
        [tenantId]
      )
    );

    return reply.send({
      by_job_type: rows.rows.map((r) => ({
        job_type: r.job_type,
        n: num(r.n),
        avg_hours_delta: num(r.avg_hours_delta),
        avg_pct_variance: num(r.avg_pct_variance),
      })),
    });
  });

  // GET /dashboard/readiness-correlation -- v_readiness_correlation, the
  // prototype's headline chart (gated vs. ungated rework rate).
  app.get("/dashboard/readiness-correlation", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const rows = await withTenant(tenantId, (tx) =>
      tx.query<ReadinessCorrelationRow>(
        `select tenant_id, readiness_bucket, jobs, rework_jobs, rework_pct
         from v_readiness_correlation
         where tenant_id = $1
         order by readiness_bucket;`,
        [tenantId]
      )
    );

    return reply.send({
      buckets: rows.rows.map((r) => ({
        readiness_bucket: r.readiness_bucket,
        jobs: num(r.jobs),
        rework_jobs: num(r.rework_jobs),
        rework_pct: num(r.rework_pct),
      })),
    });
  });

  // GET /dashboard/price-alerts -- v_price_alerts joined to catalog_item /
  // supplier for display names, and to sourcingOptions for the cheapest
  // alternative supplier for the same item (07-phase4-cost-intelligence.md
  // §2: "same shape the prototype's priceAlerts client-side logic already
  // produces"). Sorted by delta_pct descending, matching priceAlerts'
  // `.sort((a, b) => b.delta - a.delta)`.
  app.get("/dashboard/price-alerts", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const alerts = await withTenant(tenantId, async (tx: PGliteTx) => {
      const rows = await tx.query<
        PriceAlertRow & { item_name: string; item_sku: string; supplier_name: string }
      >(
        `select pa.tenant_id, pa.item_id, pa.supplier_id, pa.price, pa.prev_price, pa.delta_pct,
                ci.name as item_name, ci.sku as item_sku, s.name as supplier_name
         from v_price_alerts pa
         join catalog_item ci on ci.id = pa.item_id and ci.tenant_id = pa.tenant_id
         join supplier s on s.id = pa.supplier_id and s.tenant_id = pa.tenant_id
         where pa.tenant_id = $1
         order by pa.delta_pct desc;`,
        [tenantId]
      );

      const result = [];
      for (const row of rows.rows) {
        // Cheapest alternative supplier for the same item, excluding the
        // one that just went up -- sourcingOptions is already sorted price
        // ascending, so the first non-matching row is the cheapest
        // alternative (priceAlerts, fieldready-prototype.jsx line 457).
        const options = await sourcingOptions(tx, tenantId, row.item_id);
        const alt = options.find((o) => o.supplier_id !== row.supplier_id) ?? null;

        result.push({
          item_id: row.item_id,
          item_name: row.item_name,
          item_sku: row.item_sku,
          supplier_id: row.supplier_id,
          supplier_name: row.supplier_name,
          price: Number(row.price),
          prev_price: Number(row.prev_price),
          delta_pct: Number(row.delta_pct),
          alt: alt
            ? {
                supplier_id: alt.supplier_id,
                supplier_name: alt.supplier.name,
                price: alt.price,
              }
            : null,
        });
      }
      return result;
    });

    return reply.send({ alerts });
  });

  // GET /dashboard/recommended-actions -- application-layer sentence
  // generation over the numbers the views above already computed
  // (07-phase4-cost-intelligence.md §2: "keep the sentence templates in
  // code and the arithmetic in SQL"). Structure ported from the
  // prototype's static list (fieldready-prototype.jsx line ~583): each
  // action is { priority, title, why }, priority one of "Alta"/"Média"/
  // "Baixa" -- same three-value vocabulary the prototype's <Pill> tone
  // mapping already expects, now populated from live data instead of a
  // hardcoded array.
  app.get("/dashboard/recommended-actions", async (req, reply) => {
    const tenantId = req.auth!.tenant_id;

    const actions = await withTenant(tenantId, async (tx: PGliteTx) => {
      const out: { priority: "Alta" | "Média" | "Baixa"; title: string; why: string }[] = [];

      // 1. Readiness-gate action -- mirrors the prototype's first static
      // action exactly, now computed from v_readiness_correlation.
      const correlationRows = await tx.query<ReadinessCorrelationRow>(
        `select tenant_id, readiness_bucket, jobs, rework_jobs, rework_pct
         from v_readiness_correlation
         where tenant_id = $1;`,
        [tenantId]
      );
      const gated = correlationRows.rows.find((r) => r.readiness_bucket === "gated");
      const ungated = correlationRows.rows.find((r) => r.readiness_bucket === "ungated");
      if (ungated && Number(ungated.jobs) > 0) {
        const totalJobs = Number(ungated.jobs) + Number(gated?.jobs ?? 0);
        const ungatedRework = Number(ungated.rework_jobs);
        const gatedPct = gated?.rework_pct !== null && gated?.rework_pct !== undefined ? Number(gated.rework_pct) : null;
        const ungatedPct = Number(ungated.rework_pct ?? 0);
        const gap = gatedPct !== null ? ungatedPct - gatedPct : ungatedPct;
        out.push({
          priority: gap >= 15 ? "Alta" : "Média",
          title: "Ativar bloqueio de despacho com readiness < 100%",
          why: `${Number(ungated.jobs)} dos ${totalJobs} trabalhos foram despachados incompletos; ${ungatedRework} falharam o first-time fix.`,
        });
      }

      // 2. Standard-time revision action -- mirrors the prototype's second
      // static action, now the real job_type with the worst overrun from
      // v_hours_variance (only surfaced when it's actually an overrun).
      const varianceRows = await tx.query<HoursVarianceRow>(
        `select tenant_id, job_type, n, avg_hours_delta, avg_pct_variance
         from v_hours_variance
         where tenant_id = $1 and avg_pct_variance is not null
         order by avg_pct_variance desc
         limit 1;`,
        [tenantId]
      );
      const worstVariance = varianceRows.rows[0];
      if (worstVariance && Number(worstVariance.avg_pct_variance) > 0) {
        const pct = Number(worstVariance.avg_pct_variance);
        out.push({
          priority: pct >= 30 ? "Alta" : pct >= 10 ? "Média" : "Baixa",
          title: `Rever tempo-padrão de "${worstVariance.job_type}"`,
          why: `Desvio médio de +${pct}% sobre ${Number(worstVariance.n)} trabalho(s). Cada trabalho perde margem face ao orçamentado.`,
        });
      }

      // 3. Supplier-switch action -- mirrors the prototype's third static
      // action, now the real top price alert (by delta_pct) that has a
      // cheaper alternative supplier for the same item.
      const alertRows = await tx.query<
        PriceAlertRow & { item_name: string; supplier_name: string }
      >(
        `select pa.tenant_id, pa.item_id, pa.supplier_id, pa.price, pa.prev_price, pa.delta_pct,
                ci.name as item_name, s.name as supplier_name
         from v_price_alerts pa
         join catalog_item ci on ci.id = pa.item_id and ci.tenant_id = pa.tenant_id
         join supplier s on s.id = pa.supplier_id and s.tenant_id = pa.tenant_id
         where pa.tenant_id = $1
         order by pa.delta_pct desc;`,
        [tenantId]
      );
      for (const alertRow of alertRows.rows) {
        const options = await sourcingOptions(tx, tenantId, alertRow.item_id);
        const alt = options.find((o) => o.supplier_id !== alertRow.supplier_id) ?? null;
        const price = Number(alertRow.price);
        if (alt && alt.price < price) {
          const savings = price - alt.price;
          out.push({
            priority: Number(alertRow.delta_pct) >= 10 ? "Alta" : "Média",
            title: `Passar ${alertRow.item_name} para ${alt.supplier.name}`,
            why: `${alertRow.supplier_name} subiu para ${price.toFixed(2)} €; ${alt.supplier.name} está a ${alt.price.toFixed(2)} €. Poupa ${savings.toFixed(2)} €/un.`,
          });
          break; // only the single best supplier-switch action, same as the prototype's list (one entry per action kind).
        }
      }

      return out;
    });

    return reply.send({ actions });
  });
}
