// 07-phase4-cost-intelligence.md §4, 04-API-SPEC.md §3, fieldready-prototype.jsx
// (openState ~line 255, sourcingOptions ~line 269, pickupPlan ~line 718).
// Kept pure of any Fastify types (only DbTx), same "unit-testable
// standalone" shape as dispatch-gate.ts.
//
// This ports the prototype's working, reviewed JS -- it does not redesign
// it. Two separate ranking rules live here and must not be conflated
// (07-phase4-cost-intelligence.md §4 is explicit about this):
//   - sourcingOptions: one item, all suppliers, sorted by price ascending
//     only.
//   - pickupPlan: multiple missing items, grouped by supplier, sorted by
//     (items covered desc, currently-open desc, total price asc) -- the
//     exact tuple the prototype's pickupPlan sorts on.

import type { DbTx } from "../db.js";
import type { SupplierHours } from "@fieldready/core";

export type OpenState = { open: boolean; text: string };

export type SourcingOption = {
  id: string;
  tenant_id: string;
  supplier_id: string;
  item_id: string;
  price: number;
  prev_price: number | null;
  source: string;
  effective_at: string;
  receipt_id: string | null;
  created_by: string | null;
  supplier: {
    id: string;
    tenant_id: string;
    name: string;
    category: string | null;
    address: string | null;
    phone: string | null;
    account_note: string | null;
    place_id: string | null;
    distance_km: number | null;
    synced_at: string | null;
    hours: SupplierHours | null;
    created_at: string;
  };
  state: OpenState;
};

export type PickupPlanEntry = {
  supplier: SourcingOption["supplier"];
  state: OpenState;
  items: { checklist_item_id: string; label: string; item_id: string; qty: number; price: number }[];
  total: number;
};

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/**
 * Server-side port of fieldready-prototype.jsx's openState (~line 255).
 * `hours` is supplier.hours jsonb -- one slot (or null) per index, index ==
 * JS Date#getDay() (0 = Sunday .. 6 = Saturday), same indexing the
 * prototype and packages/core/src/supplier.ts's SupplierHours comment
 * document. Phrasing matched exactly: "Aberto até HH:MM" / "Fecha em N
 * min" / "Abre às HH:MM" / "Fechou às HH:MM" / "Fechado hoje".
 */
export function openState(hours: SupplierHours | null | undefined, now: Date = new Date()): OpenState {
  const slot = hours?.[now.getDay()];
  if (!slot) return { open: false, text: "Fechado hoje" };
  const cur = now.getHours() * 60 + now.getMinutes();
  const o = toMin(slot.open);
  const c = toMin(slot.close);
  if (cur < o) return { open: false, text: `Abre às ${slot.open}` };
  if (cur >= c) return { open: false, text: `Fechou às ${slot.close}` };
  const left = c - cur;
  return { open: true, text: left <= 60 ? `Fecha em ${left} min` : `Aberto até ${slot.close}` };
}

type SourcingRow = {
  id: string;
  tenant_id: string;
  supplier_id: string;
  item_id: string;
  price: string;
  prev_price: string | null;
  source: string;
  effective_at: string;
  receipt_id: string | null;
  created_by: string | null;
  supplier_tenant_id: string;
  supplier_name: string;
  supplier_category: string | null;
  supplier_address: string | null;
  supplier_phone: string | null;
  supplier_account_note: string | null;
  supplier_place_id: string | null;
  supplier_distance_km: string | null;
  supplier_synced_at: string | null;
  supplier_hours: SupplierHours | null;
  supplier_created_at: string;
};

/**
 * Server-side port of sourcingOptions (~line 269): every supplier_price row
 * for `itemId`, joined to its supplier, each with openState computed, sorted
 * by price ascending -- exactly the prototype's sort key, nothing else.
 * supplier_price holds one current row per (tenant, supplier, item)
 * (apps/api/src/routes/suppliers.ts's own comment), so no latest-per-
 * supplier filtering is needed here.
 */
export async function sourcingOptions(
  tx: DbTx,
  tenantId: string,
  itemId: string,
  now: Date = new Date()
): Promise<SourcingOption[]> {
  const rows = await tx.query<SourcingRow>(
    `select sp.id, sp.tenant_id, sp.supplier_id, sp.item_id, sp.price, sp.prev_price,
            sp.source, sp.effective_at, sp.receipt_id, sp.created_by,
            s.tenant_id as supplier_tenant_id, s.name as supplier_name,
            s.category as supplier_category, s.address as supplier_address,
            s.phone as supplier_phone, s.account_note as supplier_account_note,
            s.place_id as supplier_place_id, s.distance_km as supplier_distance_km,
            s.synced_at as supplier_synced_at, s.hours as supplier_hours,
            s.created_at as supplier_created_at
     from supplier_price sp
     join supplier s on s.id = sp.supplier_id and s.tenant_id = sp.tenant_id
     where sp.item_id = $1 and sp.tenant_id = $2
     order by sp.price asc;`,
    [itemId, tenantId]
  );

  return rows.rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    supplier_id: row.supplier_id,
    item_id: row.item_id,
    price: Number(row.price),
    prev_price: row.prev_price === null ? null : Number(row.prev_price),
    source: row.source,
    effective_at: row.effective_at,
    receipt_id: row.receipt_id,
    created_by: row.created_by,
    supplier: {
      id: row.supplier_id,
      tenant_id: row.supplier_tenant_id,
      name: row.supplier_name,
      category: row.supplier_category,
      address: row.supplier_address,
      phone: row.supplier_phone,
      account_note: row.supplier_account_note,
      place_id: row.supplier_place_id,
      distance_km: row.supplier_distance_km === null ? null : Number(row.supplier_distance_km),
      synced_at: row.supplier_synced_at,
      hours: row.supplier_hours,
      created_at: row.supplier_created_at,
    },
    state: openState(row.supplier_hours, now),
  }));
}

export type MissingItem = {
  checklist_item_id: string;
  label: string;
  item_id: string;
  qty: number;
};

/**
 * Server-side port of pickupPlan (~line 718): groups sourcingOptions
 * results by supplier across multiple missing items, sorted by
 * (items covered desc, currently-open desc, total price asc) -- the exact
 * tuple the prototype's pickupPlan sorts on. A separate ranking from
 * sourcingOptions's price-only sort; must not be conflated with it.
 */
export async function pickupPlan(
  tx: DbTx,
  tenantId: string,
  missingItems: MissingItem[],
  now: Date = new Date()
): Promise<PickupPlanEntry[]> {
  const bySupplier = new Map<string, PickupPlanEntry>();

  for (const missing of missingItems) {
    const options = await sourcingOptions(tx, tenantId, missing.item_id, now);
    for (const option of options) {
      let entry = bySupplier.get(option.supplier_id);
      if (!entry) {
        entry = { supplier: option.supplier, state: option.state, items: [], total: 0 };
        bySupplier.set(option.supplier_id, entry);
      }
      entry.items.push({
        checklist_item_id: missing.checklist_item_id,
        label: missing.label,
        item_id: missing.item_id,
        qty: missing.qty,
        price: option.price,
      });
      entry.total += option.price * missing.qty;
    }
  }

  return Array.from(bySupplier.values()).sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    if (a.state.open !== b.state.open) return a.state.open ? -1 : 1;
    return a.total - b.total;
  });
}
