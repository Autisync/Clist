// Receipt OCR — 07-phase4-cost-intelligence.md §5. Two implementations
// behind one interface, selected once at module load (below) based on
// whether real Veryfi credentials are configured:
//
//   FixtureReceiptOcrProvider — deterministic, no network call, used by
//     every proof/smoke script and local dev without credentials.
//   VeryfiReceiptOcrProvider  — the real vendor call, per architecture §6.
//
// Choosing Veryfi does NOT retroactively satisfy architecture §6's own bar
// ("test against ~20 real Rexel/Sonepar/Casa das Antenas receipts before
// committing to a vendor, specifically for Portuguese thermal-receipt
// formatting") — that evaluation still hasn't happened. What changed is
// only that Veryfi is now wired up for real, so that evaluation can
// actually be run against live output instead of staying blocked on
// "nothing to test against." Treat its output as unverified accuracy until
// that test happens; the human-confirm step (routes/receipts.ts,
// POST /receipts/:id/confirm) is what makes that safe in the meantime — no
// OCR output ever reaches supplier_price without a person checking it
// first, regardless of how accurate or inaccurate Veryfi turns out to be.

import { createHmac } from "node:crypto";

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

// Thrown by VeryfiReceiptOcrProvider on any failure (network, timeout,
// non-2xx, malformed response) — a distinct type so routes/receipts.ts can
// catch OCR failure specifically and degrade gracefully (save the receipt,
// zero lines, let the office user fall back to fully manual entry) rather
// than 500ing the whole upload because a third-party vendor was slow or
// down. Uptime of receipt capture must not depend on Veryfi's uptime.
export class ReceiptOcrError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "ReceiptOcrError";
  }
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

// docs.veryfi.com/api/getting-started/authentication/ and
// .../receipts-invoices/process-a-document/ (read directly, 2026-08-20 —
// cited here so the exact source is traceable if Veryfi's API ever changes
// shape, same citation discipline this project already applies to the ITED
// manual). Every field below is required per that documentation, not
// assumed:
//
//   POST https://api.veryfi.com/api/v8/partner/documents/
//   Headers: CLIENT-ID, AUTHORIZATION: "apikey USERNAME:API_KEY",
//            X-Veryfi-Request-Timestamp (ms unix epoch, string),
//            X-Veryfi-Request-Signature (see signPayload below)
//   Body:    {file_data: base64, file_name}
//   Response fields used: vendor_name, invoice_number, date, line_items[]
//     ({description, quantity, price}).
export interface VeryfiCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  apiKey: string;
}

const VERYFI_BASE_URL = "https://api.veryfi.com/api/v8/partner/documents/";
const REQUEST_TIMEOUT_MS = 20_000; // uptime: never let a hung Veryfi call hang receipt capture indefinitely

// Veryfi's documented signing scheme: HMAC-SHA256 over
// "timestamp:{ts},{key1}:{value1},{key2}:{value2}..." (only top-level,
// scalar-valued keys — file_data/file_name are both strings here, so no
// nested-value serialization question arises), base64-encoded, keyed on
// CLIENT_SECRET. Order matches insertion order of `payload`'s own keys,
// which for this provider is always {file_data, file_name} — kept as a
// plain object (not a Map) is fine because we always build it the same way
// below, but if a future caller ever needs a differently-ordered payload,
// this function's correctness depends on call-site key order, not
// something it can verify itself; noted here rather than silently assumed.
function signPayload(payload: Record<string, string>, timestamp: number, clientSecret: string): string {
  const parts = [`timestamp:${timestamp}`, ...Object.entries(payload).map(([k, v]) => `${k}:${v}`)];
  const payloadStr = parts.join(",");
  return createHmac("sha256", clientSecret).update(payloadStr).digest("base64");
}

export class VeryfiReceiptOcrProvider implements ReceiptOcrProvider {
  constructor(private readonly creds: VeryfiCredentials) {}

  async parse(imageBuffer: Buffer): Promise<ReceiptOcrResult> {
    const timestamp = Date.now();
    const body: Record<string, string> = {
      file_data: imageBuffer.toString("base64"),
      file_name: "receipt.jpg",
    };
    const signature = signPayload(body, timestamp, this.creds.clientSecret);

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(VERYFI_BASE_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "CLIENT-ID": this.creds.clientId,
          AUTHORIZATION: `apikey ${this.creds.username}:${this.creds.apiKey}`,
          "X-Veryfi-Request-Timestamp": String(timestamp),
          "X-Veryfi-Request-Signature": signature,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network failure or the AbortController firing (timeout) both land
      // here — neither is a Veryfi response we can parse, both are equally
      // "the vendor call failed," which is exactly the case
      // routes/receipts.ts needs to distinguish from a real bug.
      throw new ReceiptOcrError(
        controller.signal.aborted
          ? `Veryfi request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : "Veryfi request failed (network error)",
        err
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      // Read the body for the error message but never let a malformed
      // error response itself throw an unhandled exception here.
      const text = await res.text().catch(() => "");
      throw new ReceiptOcrError(`Veryfi returned ${res.status}: ${text.slice(0, 500)}`);
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new ReceiptOcrError("Veryfi returned a non-JSON response", err);
    }

    return normalizeVeryfiResponse(json);
  }
}

// Deliberately defensive: a third-party API's response shape is not
// something this codebase controls, so every field is read optionally and
// coerced, rather than trusting `json` matches the documented shape
// exactly — a vendor-side field rename or omission should degrade to
// "fewer parsed lines," never a crash.
function normalizeVeryfiResponse(json: unknown): ReceiptOcrResult {
  const obj = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const rawLines = Array.isArray(obj.line_items) ? obj.line_items : [];

  const lines: ReceiptOcrLine[] = rawLines
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === "object")
    .map((l) => ({
      description: typeof l.description === "string" ? l.description : "Artigo não identificado",
      qty: typeof l.quantity === "number" ? l.quantity : 1,
      unit_price: typeof l.price === "number" ? l.price : 0,
    }));

  return {
    supplier_guess: typeof obj.vendor_name === "string" ? obj.vendor_name : undefined,
    doc_number: typeof obj.invoice_number === "string" ? obj.invoice_number : undefined,
    receipt_date: typeof obj.date === "string" ? obj.date : undefined,
    lines,
  };
}

// Provider selection — real Veryfi only when all four credentials are
// genuinely present; the fixture otherwise. This is read once at module
// load, not per-request, so a mid-process env change never flips behavior
// unexpectedly mid-flight. Proof/smoke scripts must never accidentally
// pick up real credentials from the host environment — see
// apps/api/test/phase4-proof.mjs's spawnApi(), which explicitly strips
// these four keys from the child process's env regardless of what the
// shell running the proof script has set, so this selection is
// deterministic in CI/proof runs no matter what.
function loadVeryfiCredentials(): VeryfiCredentials | null {
  const clientId = process.env.VERYFI_CLIENT_ID;
  const clientSecret = process.env.VERYFI_CLIENT_SECRET;
  const username = process.env.VERYFI_USERNAME;
  const apiKey = process.env.VERYFI_API_KEY;
  if (!clientId || !clientSecret || !username || !apiKey) return null;
  return { clientId, clientSecret, username, apiKey };
}

const veryfiCredentials = loadVeryfiCredentials();
export const receiptOcrProvider: ReceiptOcrProvider = veryfiCredentials
  ? new VeryfiReceiptOcrProvider(veryfiCredentials)
  : new FixtureReceiptOcrProvider();
