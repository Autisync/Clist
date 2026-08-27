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

export interface PlaceSearchResult {
  place_id: string;
  name: string;
  address: string | null;
}

export interface PlacesProvider {
  refresh(placeId: string): Promise<PlacesRefreshResult>;
  // Text search — "type a supplier name, get real candidate places back" —
  // the automation this interface grew to support after refresh() alone
  // still left office users copy-pasting a place_id out of Google's own
  // separate Place ID Finder tool by hand. Same fixture/real split as
  // refresh(): FixturePlacesProvider matches by substring against the same
  // four demo suppliers FIXTURE_SUPPLIERS already knows, so local dev and
  // every proof/smoke script exercise this deterministically too.
  search(query: string): Promise<PlaceSearchResult[]>;
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

// Display names for the same four fixture suppliers, keyed the same way —
// FIXTURE_SUPPLIERS itself never needed a name (refresh() doesn't return
// one), search() does. Kept as a separate small map rather than widening
// PlacesRefreshResult with an unused field real GooglePlacesProvider
// callers would have to populate too.
const FIXTURE_SUPPLIER_NAMES: Record<string, string> = {
  ChIJ_mock_rexel_alf: "Rexel Alfragide",
  ChIJ_mock_sonepar_pv: "Sonepar Prior Velho",
  ChIJ_mock_antenas_amd: "Antenas Amadora",
  ChIJ_mock_lm_alf: "Leroy Merlin Alfragide",
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

  async search(query: string): Promise<PlaceSearchResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return Object.entries(FIXTURE_SUPPLIER_NAMES)
      .filter(([, name]) => name.toLowerCase().includes(q))
      .map(([place_id, name]) => ({ place_id, name, address: FIXTURE_SUPPLIERS[place_id]?.address ?? null }));
  }
}

// Real Google Places API (New) integration — architecture §6. Same
// "credentials present -> real vendor, otherwise the fixture" selection
// receipt-ocr-provider.ts already uses for Veryfi; provider selection
// happens once below, at module load.
//
// Thrown by GooglePlacesProvider on any failure (network, timeout,
// non-2xx other than 404, malformed response) — routes/suppliers.ts
// catches this specifically and degrades to "no update, existing
// address/phone/hours kept" rather than 500ing the whole request, same
// "uptime must not depend on a third-party vendor" shape ReceiptOcrError
// already established for receipt-ocr-provider.ts.
export class PlacesApiError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "PlacesApiError";
  }
}

const PLACES_API_BASE = "https://places.googleapis.com/v1";
// Minimal field mask — Places API (New) bills by which fields are
// requested, so this asks for exactly the three refresh() promises
// (address/phone/hours), nothing more.
const FIELD_MASK = "formattedAddress,internationalPhoneNumber,regularOpeningHours";

interface GooglePlacePoint {
  day: number; // 0=Sunday..6=Saturday — same convention as JS Date#getDay(),
  hour: number; // which is also SupplierHoursSlot.dow's own convention
  minute: number; // (packages/core/src/supplier.ts) — no remapping needed.
}
interface GooglePeriod {
  open?: GooglePlacePoint;
  close?: GooglePlacePoint;
}
interface GooglePlaceDetailsResponse {
  formattedAddress?: string;
  internationalPhoneNumber?: string;
  regularOpeningHours?: { periods?: GooglePeriod[] };
}

function toHHMM(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Known, deliberate simplification: SupplierHoursSlot supports exactly one
// open/close pair per day — no representation for split hours (closed for
// lunch) or a close time past midnight into the next day. A place with
// either of those reports only its FIRST period per day here. Fixing this
// for real means widening SupplierHoursSlot itself (packages/core), not
// something to paper over silently in this one provider — same "narrow
// but honest" trade-off FIXTURE_SUPPLIERS' own Saturday-only special case
// already made above.
function normalizeOpeningHours(periods: GooglePeriod[] | undefined): SupplierHours | null {
  if (!periods || periods.length === 0) return null;
  const byDay = new Map<number, GooglePeriod>();
  for (const p of periods) {
    if (p.open === undefined || byDay.has(p.open.day)) continue;
    byDay.set(p.open.day, p);
  }
  const week: SupplierHours = [];
  for (let dow = 0; dow <= 6; dow++) {
    const p = byDay.get(dow);
    week.push(
      p?.open && p.close
        ? { dow, open: toHHMM(p.open.hour, p.open.minute), close: toHHMM(p.close.hour, p.close.minute) }
        : null
    );
  }
  return week;
}

export class GooglePlacesProvider implements PlacesProvider {
  constructor(private readonly apiKey: string) {}

  async refresh(placeId: string): Promise<PlacesRefreshResult> {
    let res: Response;
    try {
      res = await fetch(`${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`, {
        headers: { "X-Goog-Api-Key": this.apiKey, "X-Goog-FieldMask": FIELD_MASK },
      });
    } catch (err) {
      throw new PlacesApiError("Google Places API request failed (network)", err);
    }

    if (res.status === 404) {
      // A real, expected case, not a failure — a mock place_id
      // (FIXTURE_SUPPLIERS' own ChIJ_mock_* keys, still seeded in demo
      // data) or any supplier not yet given a real Google place_id will
      // always 404 here. Degrades to "nothing to update" exactly like
      // GENERIC_FALLBACK already does for the fixture provider's own
      // unrecognized-key case, not an error.
      return GENERIC_FALLBACK;
    }
    if (!res.ok) {
      throw new PlacesApiError(`Google Places API returned ${res.status}`, await res.text().catch(() => undefined));
    }

    let json: GooglePlaceDetailsResponse;
    try {
      json = await res.json();
    } catch (err) {
      throw new PlacesApiError("Google Places API returned a non-JSON response", err);
    }

    return {
      address: json.formattedAddress ?? null,
      phone: json.internationalPhoneNumber ?? null,
      hours: normalizeOpeningHours(json.regularOpeningHours?.periods),
    };
  }

  async search(query: string): Promise<PlaceSearchResult[]> {
    const q = query.trim();
    if (!q) return [];

    let res: Response;
    try {
      res = await fetch(`${PLACES_API_BASE}/places:searchText`, {
        method: "POST",
        headers: {
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
          "content-type": "application/json",
        },
        // regionCode biases (doesn't restrict) results towards Portugal —
        // every real supplier this app has seeded or seen so far is a PT
        // address, and Text Search's own relevance ranking otherwise has
        // no location signal to work from at all for a bare business name.
        body: JSON.stringify({ textQuery: q, regionCode: "PT" }),
      });
    } catch (err) {
      throw new PlacesApiError("Google Places API search request failed (network)", err);
    }

    if (!res.ok) {
      throw new PlacesApiError(`Google Places API search returned ${res.status}`, await res.text().catch(() => undefined));
    }

    let json: { places?: { id?: string; displayName?: { text?: string }; formattedAddress?: string }[] };
    try {
      json = await res.json();
    } catch (err) {
      throw new PlacesApiError("Google Places API search returned a non-JSON response", err);
    }

    // Defensively filtered/coerced, same reasoning receipt-ocr-provider.ts's
    // own normalizeVeryfiResponse comment gives for a third-party response
    // shape this codebase doesn't control: a result missing an id is
    // useless (nothing to refresh against later) and dropped rather than
    // passed through with a hole in it.
    return (json.places ?? [])
      .filter((p): p is { id: string; displayName?: { text?: string }; formattedAddress?: string } => Boolean(p.id))
      .map((p) => ({
        place_id: p.id,
        name: p.displayName?.text ?? p.formattedAddress ?? p.id,
        address: p.formattedAddress ?? null,
      }));
  }
}

// Provider selection — real Google Places only when a key is genuinely
// configured; the fixture otherwise. Read once at module load, not
// per-request, same reasoning as receipt-ocr-provider.ts's own
// loadVeryfiCredentials(). Proof/smoke scripts must never accidentally
// pick up a real key from the host environment — test/phase4-proof.mjs's
// spawnServer() strips GOOGLE_PLACES_API_KEY from the child process's env
// for exactly this reason, mirroring its existing VERYFI_* stripping.
function loadGooglePlacesApiKey(): string | null {
  return process.env.GOOGLE_PLACES_API_KEY || null;
}

const googlePlacesApiKey = loadGooglePlacesApiKey();
export const placesProvider: PlacesProvider = googlePlacesApiKey
  ? new GooglePlacesProvider(googlePlacesApiKey)
  : new FixturePlacesProvider();
