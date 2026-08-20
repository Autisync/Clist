// Google Places substitution — 07-phase4-cost-intelligence.md §3: "needs a
// live Google Places API call, which (like Postgres and S3 in earlier
// phases) likely isn't available in whatever sandbox this gets built in."
// Same honest-substitution pattern as db.ts (PGlite standing in for a real
// Postgres server) and object-store.ts (local filesystem standing in for
// S3/R2): a small interface here, a fixture-backed implementation for
// dev/proof, and a real Google Places implementation swapped in at deploy
// time by changing this file only — nothing that calls PlacesProvider needs
// to change. There are no real Google Places credentials in this
// environment, so this is not a stubbed-out TODO, it's the actual substitute
// this phase ships with (07-phase4-cost-intelligence.md §3).

import type { SupplierHours } from "@fieldready/core";

export interface PlacesRefreshResult {
  address: string | null;
  hours: SupplierHours | null;
  phone: string | null;
}

export interface PlacesProvider {
  refresh(placeId: string): Promise<PlacesRefreshResult>;
}

// One entry per day of the week, dow == JS Date#getDay() (0 = Sunday ..
// 6 = Saturday), matching supplier.hours' documented jsonb shape
// (03-schema.sql §5) and fieldready-prototype.jsx's WEEK()/openState()
// indexing exactly.
function week(open: string, close: string, sat: { open: string; close: string } | null): SupplierHours {
  return [null, { dow: 1, open, close }, { dow: 2, open, close }, { dow: 3, open, close },
          { dow: 4, open, close }, { dow: 5, open, close }, sat ? { dow: 6, ...sat } : null];
}

// Ported verbatim (addresses/hours/phones) from fieldready-prototype.jsx's
// SUPPLIERS array (~line 43) — the same four real Lisbon-area suppliers the
// prototype's UI already shows, keyed by the same mock place_ids.
const FIXTURE_SUPPLIERS: Record<string, PlacesRefreshResult> = {
  ChIJ_mock_rexel_alf: {
    address: "Estrada de Alfragide 67, 2610-008 Amadora",
    phone: "+351 21 471 0000",
    hours: week("08:00", "18:30", null),
  },
  ChIJ_mock_sonepar_pv: {
    address: "Rua Cidade de Bissau 8, 2685-223 Prior Velho",
    phone: "+351 21 942 0000",
    hours: week("08:30", "18:00", null),
  },
  ChIJ_mock_antenas_amd: {
    address: "Av. Santos Mattos 14, 2700-757 Amadora",
    phone: "+351 21 493 0000",
    hours: week("09:00", "19:00", { open: "09:00", close: "13:00" }),
  },
  ChIJ_mock_lm_alf: {
    address: "Alfragide Retail Park, 2610-016 Amadora",
    phone: "+351 21 000 0000",
    hours: [
      { dow: 0, open: "09:00", close: "20:00" },
      { dow: 1, open: "09:00", close: "22:00" },
      { dow: 2, open: "09:00", close: "22:00" },
      { dow: 3, open: "09:00", close: "22:00" },
      { dow: 4, open: "09:00", close: "22:00" },
      { dow: 5, open: "09:00", close: "22:00" },
      { dow: 6, open: "09:00", close: "22:00" },
    ],
  },
};

// Generic fallback for a place_id this fixture doesn't recognize — falls
// back rather than throwing (07-phase4-cost-intelligence.md §3), same
// spirit as receipt_line's "sem correspondência" null-item_id case: an
// unrecognized upstream key degrades to "we don't know yet", not a 500.
const GENERIC_FALLBACK: PlacesRefreshResult = {
  address: null,
  phone: null,
  hours: null,
};

export class FixturePlacesProvider implements PlacesProvider {
  async refresh(placeId: string): Promise<PlacesRefreshResult> {
    return FIXTURE_SUPPLIERS[placeId] ?? GENERIC_FALLBACK;
  }
}

// Real deployment: implement `PlacesProvider` against the actual Google
// Places API (architecture §6) and swap the export below — every caller
// (routes/suppliers.ts) depends only on the interface.
export const placesProvider: PlacesProvider = new FixturePlacesProvider();
