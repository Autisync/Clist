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

  // Only set content-type: application/json when there actually is a body.
  // Some routes take no request body at all (POST /quotes/:id/accept,
  // POST /quotes/:id/create-job) — sending that header with an empty body
  // makes Fastify's JSON body parser 500 with "Body cannot be empty when
  // content-type is set to 'application/json'", so the header has to be
  // conditional on options.body being present, not just on isFormData.
  const res = await fetch(toUrl(path), {
    ...options,
    credentials: "same-origin",
    headers:
      isFormData || options.body === undefined
        ? options.headers
        : {
            "content-type": "application/json",
            ...options.headers,
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
