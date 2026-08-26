/*
 * Typed fetch helpers for talking to the FieldReady API.
 *
 * Every request targets `/api/<path>` — same-origin, proxied by the
 * next.config.ts rewrite to the real Fastify API. Never fetch the API port
 * directly (see CLAUDE.md / build task: no CORS setup exists on purpose).
 *
 * Two entry points:
 *   - apiFetch: for Client Components. Browser fetches are same-origin, so
 *     the fr_session cookie rides along automatically.
 *   - serverApiFetch: for Server Components / route handlers. Server-side
 *     fetches do NOT automatically forward the incoming request's cookies,
 *     so this reads them from next/headers' cookies() and attaches the
 *     fr_session cookie by hand. Any server-side data fetch MUST use this
 *     variant, not apiFetch — that's the #1 way this kind of app breaks.
 *
 * Both ALSO attach `Authorization: Bearer <supabase access token>` when a
 * real Supabase session exists — a real, previously-invisible gap: office
 * `/login` (§6 Step 5) signs in via Supabase only and never sets fr_session
 * at all, so every real production office user got a silent 401 from every
 * still-Fastify route (photo upload, receipts, refresh-places, technician
 * pairing) the moment fr_session stopped existing. apps/api's requireAuth
 * (auth/middleware.ts) now accepts either — this is the other half of that
 * fix. fr_session, where present, still takes priority (unchanged classic-
 * system behavior, zero regression); the bearer token is what makes a
 * Supabase-only caller work at all. `./supabase/client` is "use client" —
 * imported dynamically inside apiFetch only, same reasoning serverApiFetch's
 * own dynamic `next/headers` import already gives, so this shared module
 * doesn't drag a client-only boundary into serverApiFetch's Server Component
 * callers.
 */

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API request failed with status ${status}`;
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toUrl(path: string): string {
  return path.startsWith("/api") ? path : `/api${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Fetch helper for use from Client Components (and anywhere same-origin
 * browser cookies are already sent automatically).
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  // See file header comment — dynamic import keeps this "use client" module
  // out of serverApiFetch's own bundle. getSession() reads the already-
  // parsed session from the SSR cookie helper's in-memory store; it does
  // not itself make a network call unless the access token is expired and
  // needs a refresh, so this doesn't add a round trip to the common case.
  const { createSupabaseBrowserClient } = await import("./supabase/client");
  const {
    data: { session },
  } = await createSupabaseBrowserClient().auth.getSession();

  // Only set content-type: application/json when there actually is a body.
  // Some routes take no request body at all (POST /quotes/:id/accept,
  // POST /quotes/:id/create-job) — sending that header with an empty body
  // makes Fastify's JSON body parser 500 with "Body cannot be empty when
  // content-type is set to 'application/json'", so the header has to be
  // conditional on options.body being present, not just on isFormData.
  const res = await fetch(toUrl(path), {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(session ? { authorization: `Bearer ${session.access_token}` } : {}),
      ...(isFormData || options.body === undefined
        ? options.headers
        : { "content-type": "application/json", ...options.headers }),
    },
  });

  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}

/**
 * Multipart photo upload for a Client Component — POST /jobs/:id/photos.
 * Multipart bodies don't go through apiFetch's JSON content-type logic in a
 * useful way (there's no JSON to serialize), so this builds its own
 * FormData and hands it to apiFetch, which already special-cases
 * `options.body instanceof FormData` by leaving the content-type header
 * unset — the browser then sets `multipart/form-data; boundary=...` itself.
 *
 * Fields are appended before the file part, matching the API's own doc
 * comment (fields must arrive before the file part for @fastify/multipart
 * to see them via data.fields at the point req.file() resolves).
 */
export async function uploadPhoto(
  jobId: string,
  file: File,
  phase: "before" | "during" | "after" | "evidence",
  requiredTag?: string
): Promise<{ id: string; job_id: string; phase: string; required_tag: string | null; file: string; taken_at: string; taken_by: string | null }> {
  const formData = new FormData();
  formData.append("phase", phase);
  if (requiredTag) formData.append("required_tag", requiredTag);
  formData.append("file", file);

  return apiFetch(`/jobs/${jobId}/photos`, {
    method: "POST",
    body: formData,
  });
}

/**
 * Multipart receipt upload for a Client Component — POST /receipts. Same
 * "fields before file part" shape as uploadPhoto above (required for
 * @fastify/multipart to see data.fields by the time req.file() resolves,
 * per apps/api/src/routes/receipts.ts's own comment).
 */
export async function uploadReceipt(
  file: File,
  metadata: { supplier_id?: string; doc_number?: string; receipt_date?: string }
): Promise<{
  id: string;
  lines: {
    id: string;
    tenant_id: string;
    receipt_id: string;
    item_id: string | null;
    description: string;
    qty: string;
    unit_price: string;
  }[];
  // true when the OCR vendor call failed (timeout/network/non-2xx) and the
  // receipt was saved with zero parsed lines instead of the upload failing
  // outright -- apps/api/src/routes/receipts.ts's graceful-degradation
  // path. Always present; false in the normal case.
  ocr_failed: boolean;
}> {
  const formData = new FormData();
  if (metadata.supplier_id) formData.append("supplier_id", metadata.supplier_id);
  if (metadata.doc_number) formData.append("doc_number", metadata.doc_number);
  if (metadata.receipt_date) formData.append("receipt_date", metadata.receipt_date);
  formData.append("file", file);

  return apiFetch("/receipts", {
    method: "POST",
    body: formData,
  });
}

/**
 * Fetch helper for use from Server Components, layouts, and route
 * handlers. Manually forwards the fr_session cookie from the incoming
 * request — Server Component fetches otherwise arrive at the API with no
 * cookie at all and look logged-out.
 */
export async function serverApiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  // Imported dynamically inside the function (rather than at module top
  // level) so this file can be imported from Client Components too without
  // pulling in next/headers, which throws outside a Server Component.
  const { cookies, headers: nextHeaders } = await import("next/headers");
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("fr_session");
  const incomingHeaders = await nextHeaders();

  // See file header comment — real Supabase session, forwarded as a bearer
  // token for the same reason apiFetch does above. Deliberately NOT
  // `./supabase/server`'s createSupabaseServerClient() here, even via a
  // dynamic import: that module statically imports next/headers at ITS OWN
  // top level, and Next's build traces a dynamic import's own static
  // imports regardless — confirmed the hard way, this exact substitution
  // broke the build with "You're importing a component that needs
  // next/headers... not supported in the pages/ directory" from a Client
  // Component path (SyncStatus.tsx -> offline-queue.ts -> this file).
  // @supabase/ssr's createServerClient has no such import (it takes a
  // cookie adapter as a plain argument), so constructing it inline here,
  // reusing the cookieStore already read above, avoids the transitive
  // boundary entirely instead of duplicating a second copy of ./server.ts.
  const { createServerClient } = await import("@supabase/ssr");
  const { supabaseUrl, supabaseAnonKey } = await import("./supabase/env");
  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  // See apiFetch's matching comment: omit content-type: application/json
  // when there's no body, or Fastify 500s on routes that take no request
  // body (e.g. POST /quotes/:id/accept, POST /quotes/:id/create-job).
  const requestHeaders: Record<string, string> =
    isFormData || options.body === undefined
      ? { ...(options.headers as Record<string, string> | undefined) }
      : {
          "content-type": "application/json",
          ...(options.headers as Record<string, string> | undefined),
        };

  if (sessionCookie) {
    requestHeaders["cookie"] = `fr_session=${sessionCookie.value}`;
  }
  if (session) {
    requestHeaders["authorization"] = `Bearer ${session.access_token}`;
  }

  // Server-side fetches need an absolute URL — there's no browser origin to
  // resolve a relative path against. Derive it from the incoming request's
  // own Host header (falls back to localhost:3000 for standalone scripts)
  // so this keeps working behind whatever host/port Next.js is actually
  // served on, instead of hardcoding one.
  const host = incomingHeaders.get("host") || "127.0.0.1:3000";
  const proto =
    incomingHeaders.get("x-forwarded-proto") ||
    (host.startsWith("127.0.0.1") || host.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${host}`;

  const res = await fetch(new URL(toUrl(path), origin), {
    ...options,
    headers: requestHeaders,
    cache: "no-store",
  });

  const body = await parseBody(res);
  if (!res.ok) {
    throw new ApiError(res.status, body);
  }
  return body as T;
}
