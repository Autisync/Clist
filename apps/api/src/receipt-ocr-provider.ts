// Receipt OCR substitution — 07-phase4-cost-intelligence.md §5: "an
// evaluation task wearing an engineering interface." Architecture §6 is
// explicit that picking a real vendor (Veryfi / Mindee / Google Document AI
// / ...) requires testing against ~20 real Rexel/Sonepar/Casa das Antenas
// receipts first, specifically for Portuguese thermal-receipt formatting —
// that test is empirical and hasn't happened. This file is NOT that choice.
// It is the same "small interface + fixture-backed implementation" shape as
// places-provider.ts (Google Places) and object-store.ts (S3/R2): ships the
// swap point now, so the eventual real vendor is a one-file change behind
// this interface, not a rewrite of routes/receipts.ts.
//
// FixtureReceiptOcrProvider deliberately does not read the image bytes at
// all — it's a stand-in for a real OCR vendor's *response shape*, not a toy
// OCR engine. Don't be tempted to add "real" parsing here; that would just
// be a fake vendor choice instead of an honestly-absent one.

export interface ReceiptOcrLine {
  description: string;
  qty: number;
  unit_price: number;
}

export interface ReceiptOcrResult {
  supplier_guess?: string;
  doc_number?: string;
  receipt_date?: string;
  lines: ReceiptOcrLine[];
}

export interface ReceiptOcrProvider {
  parse(imageBuffer: Buffer): Promise<ReceiptOcrResult>;
}

// A small, deterministic set of lines standing in for a real vendor's
// response. One line ("Material diverso (ver talão)") is intentionally a
// description that won't match any seeded catalog_item by name/sku — the
// "sem correspondência" case routes/receipts.ts leaves with item_id = null,
// same case the prototype's receipt-review modal already renders.
export class FixtureReceiptOcrProvider implements ReceiptOcrProvider {
  async parse(_imageBuffer: Buffer): Promise<ReceiptOcrResult> {
    return {
      supplier_guess: "Rexel Alfragide",
      doc_number: "FT 2026/00123",
      receipt_date: "2026-08-18",
      lines: [
        { description: "Cabo coaxial RG6 (bobine 100m)", qty: 1, unit_price: 42.5 },
        { description: "Conector F compressão", qty: 20, unit_price: 0.35 },
        { description: "Material diverso (ver talão)", qty: 1, unit_price: 12.9 },
      ],
    };
  }
}

// Real deployment: implement `ReceiptOcrProvider` against whichever vendor
// wins the ~20-receipt evaluation (07-phase4-cost-intelligence.md §5) and
// swap the export below — every caller (routes/receipts.ts) depends only on
// the interface.
export const receiptOcrProvider: ReceiptOcrProvider = new FixtureReceiptOcrProvider();
