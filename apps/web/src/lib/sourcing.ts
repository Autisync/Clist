/*
 * Client-side display-only port of openState (fieldready-prototype.jsx
 * ~line 255, apps/api/src/domain/sourcing.ts's server copy). Used only to
 * render a supplier's open/closed pill on the office Suppliers page — the
 * actual sourcing/pickup-plan *rankings* always come from the real API
 * (GET /catalog-items/:id/sourcing, GET /jobs/:id/pickup-plan), never
 * recomputed client-side, so there's no risk of the two ranking algorithms
 * (07-phase4-cost-intelligence.md §4) drifting apart here — this file only
 * ever answers "is it open right now", never "which supplier is best".
 */

import type { SupplierHours } from "@fieldready/core";

export type OpenState = { open: boolean; text: string };

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

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
