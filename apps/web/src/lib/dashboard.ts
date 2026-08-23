/*
 * §6 Step 5: Supabase-native port of apps/api/src/routes/dashboard.ts's
 * price-alerts join and recommended-actions sentence generation — the two
 * pieces of that route that are more than a thin view read (API spec §8's
 * own words: "if a number needs to change, it changes in 03-schema.sql,
 * not in two places" — the four v_* views themselves are still the sole
 * source of the arithmetic, read directly via plain `.from(...)` calls
 * from apps/web/src/app/office/page.tsx; this file only re-hosts the join
 * to find a price alert's cheapest alternative supplier and the sentence
 * templates, exactly as the Fastify route already did, since neither
 * needs privileges beyond what RLS already grants the calling session).
 *
 * sourcingOptionsFor ports domain/sourcing.ts's sourcingOptions() — same
 * query (supplier_price join supplier, sorted price ascending), just
 * expressed as a Supabase embedded-resource select instead of raw SQL.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type SourcingOption = {
  supplier_id: string;
  price: number;
  supplier_name: string;
};

async function sourcingOptionsFor(
  supabase: SupabaseClient,
  itemId: string
): Promise<SourcingOption[]> {
  const { data, error } = await supabase
    .from("supplier_price")
    .select("supplier_id, price, supplier(name)")
    .eq("item_id", itemId)
    .order("price", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier;
    return { supplier_id: row.supplier_id, price: Number(row.price), supplier_name: supplier?.name ?? "" };
  });
}

export type PriceAlert = {
  item_id: string;
  item_name: string;
  item_sku: string;
  supplier_id: string;
  supplier_name: string;
  price: number;
  prev_price: number;
  delta_pct: number;
  alt: { supplier_id: string; supplier_name: string; price: number } | null;
};

// Ports GET /dashboard/price-alerts — v_price_alerts joined to
// catalog_item/supplier for display names, and to sourcingOptionsFor for
// the cheapest alternative supplier, sorted by delta_pct descending.
export async function loadPriceAlerts(supabase: SupabaseClient): Promise<PriceAlert[]> {
  const { data, error } = await supabase
    .from("v_price_alerts")
    .select("item_id, supplier_id, price, prev_price, delta_pct, catalog_item(name, sku), supplier(name)")
    .order("delta_pct", { ascending: false });
  if (error) throw error;

  const alerts: PriceAlert[] = [];
  for (const row of data ?? []) {
    const item = Array.isArray(row.catalog_item) ? row.catalog_item[0] : row.catalog_item;
    const supplier = Array.isArray(row.supplier) ? row.supplier[0] : row.supplier;
    const options = await sourcingOptionsFor(supabase, row.item_id);
    const alt = options.find((o) => o.supplier_id !== row.supplier_id) ?? null;
    alerts.push({
      item_id: row.item_id,
      item_name: item?.name ?? "",
      item_sku: item?.sku ?? "",
      supplier_id: row.supplier_id,
      supplier_name: supplier?.name ?? "",
      price: Number(row.price),
      prev_price: Number(row.prev_price),
      delta_pct: Number(row.delta_pct),
      alt: alt ? { supplier_id: alt.supplier_id, supplier_name: alt.supplier_name, price: alt.price } : null,
    });
  }
  return alerts;
}

export type RecommendedAction = { priority: "Alta" | "Média" | "Baixa"; title: string; why: string };

type ReadinessBucket = {
  readiness_bucket: "gated" | "ungated";
  jobs: number | string | null;
  rework_jobs: number | string | null;
  rework_pct: number | string | null;
};

type HoursVarianceRow = {
  job_type: string;
  n: number | string | null;
  avg_hours_delta: number | string | null;
  avg_pct_variance: number | string | null;
};

// Ports GET /dashboard/recommended-actions — application-layer sentence
// generation over the numbers the views already computed
// (07-phase4-cost-intelligence.md §2: "keep the sentence templates in code
// and the arithmetic in SQL"). Same three actions, same thresholds, same
// vocabulary as the Fastify route this replaces, ported literally, not
// redesigned.
export async function loadRecommendedActions(
  supabase: SupabaseClient,
  correlationBuckets: ReadinessBucket[],
  hoursVarianceRows: HoursVarianceRow[],
  priceAlerts: PriceAlert[]
): Promise<RecommendedAction[]> {
  const out: RecommendedAction[] = [];

  // 1. Readiness-gate action.
  const gated = correlationBuckets.find((r) => r.readiness_bucket === "gated");
  const ungated = correlationBuckets.find((r) => r.readiness_bucket === "ungated");
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

  // 2. Standard-time revision action — the real job_type with the worst
  // overrun (hoursVarianceRows is already sorted avg_pct_variance desc by
  // the caller, matching v_hours_variance's own order by).
  const worstVariance = hoursVarianceRows.find((r) => r.avg_pct_variance !== null);
  if (worstVariance && Number(worstVariance.avg_pct_variance) > 0) {
    const pct = Number(worstVariance.avg_pct_variance);
    out.push({
      priority: pct >= 30 ? "Alta" : pct >= 10 ? "Média" : "Baixa",
      title: `Rever tempo-padrão de "${worstVariance.job_type}"`,
      why: `Desvio médio de +${pct}% sobre ${Number(worstVariance.n)} trabalho(s). Cada trabalho perde margem face ao orçamentado.`,
    });
  }

  // 3. Supplier-switch action — the top price alert (by delta_pct,
  // priceAlerts is already sorted that way) that has a cheaper alternative
  // supplier for the same item. Only the single best one, same as the
  // route this ports.
  for (const alertRow of priceAlerts) {
    if (alertRow.alt && alertRow.alt.price < alertRow.price) {
      const savings = alertRow.price - alertRow.alt.price;
      out.push({
        priority: alertRow.delta_pct >= 10 ? "Alta" : "Média",
        title: `Passar ${alertRow.item_name} para ${alertRow.alt.supplier_name}`,
        why: `${alertRow.supplier_name} subiu para ${alertRow.price.toFixed(2)} €; ${alertRow.alt.supplier_name} está a ${alertRow.alt.price.toFixed(2)} €. Poupa ${savings.toFixed(2)} €/un.`,
      });
      break;
    }
  }

  return out;
}
