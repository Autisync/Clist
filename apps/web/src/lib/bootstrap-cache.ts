/*
 * Bootstrap read-cache — the download-direction counterpart to
 * offline-queue.ts's upload-direction outbox. GET /api/sync/bootstrap
 * (apps/api/src/routes/sync.ts) returns everything the device needs to
 * operate fully offline: the technician's own assigned jobs (with their
 * readiness/execution/test-protocol snapshots and checklist item statuses),
 * the latest van audit, and the tenant's equipment list.
 *
 * Cached into the "bootstrap-cache" object store of the same
 * "fieldready-outbox" IndexedDB database offline-queue.ts owns (see
 * openFieldReadyDb there) — a single row keyed by BOOTSTRAP_CACHE_KEY, since
 * there is exactly one bootstrap snapshot per device, not one per job.
 *
 * getCachedBootstrap() is the synchronous-feeling read path: field pages
 * call it on mount to render instantly from whatever was last cached, with
 * no network dependency. refreshBootstrap() is the write path: fetch fresh
 * data and overwrite the cached row when online. Neither page-wires this
 * yet (that's the next stage) — this file only provides the two functions.
 */

import { openFieldReadyDb, BOOTSTRAP_STORE } from "./offline-queue";
import { apiFetch } from "./api";

// GET /sync/bootstrap's actual response shape (apps/api/src/routes/sync.ts).
// Kept as a local type rather than a @fieldready/core export because the
// route builds this shape inline (not from a shared Zod schema) — mirrors
// the route's own return value field-for-field, including `van_audits`
// (plural, an array capped at 1 row server-side) and the deliberately loose
// per-job snapshot fields (they're already-resolved JSON blobs, not
// re-validated client-side).
export interface BootstrapJob {
  id: string;
  readiness_snapshot: unknown;
  execution_snapshot: unknown;
  test_protocol_snapshot: unknown;
  checklist_items: { id: string; status: string }[];
}

export interface BootstrapData {
  cursor: string;
  jobs: BootstrapJob[];
  van_audits: unknown[];
  equipment: unknown[];
}

// Single-row key — there is one bootstrap snapshot per device, not one per
// job, so the "bootstrap-cache" store only ever holds this one row.
const BOOTSTRAP_CACHE_KEY = "bootstrap";

/**
 * Read the last-cached bootstrap snapshot from IndexedDB, if any. Returns
 * null when nothing has ever been cached (fresh install, cleared storage) —
 * callers should treat that as "no offline data yet", not an error.
 */
export async function getCachedBootstrap(): Promise<BootstrapData | null> {
  const db = await openFieldReadyDb();
  const row = await db.get(BOOTSTRAP_STORE, BOOTSTRAP_CACHE_KEY);
  return row ? (row.data as BootstrapData) : null;
}

/**
 * Fetch a fresh bootstrap snapshot from the API and overwrite the cached
 * row. Meant to be called opportunistically (app open, regained
 * connectivity) alongside — not instead of — getCachedBootstrap(), so a
 * page can render the cached snapshot immediately and let this update it in
 * the background. Swallows network failures (offline, timeout, rejected
 * request) and returns null rather than throwing, leaving whatever was
 * previously cached untouched.
 */
export async function refreshBootstrap(): Promise<BootstrapData | null> {
  let data: BootstrapData;
  try {
    data = await apiFetch<BootstrapData>("/sync/bootstrap");
  } catch {
    return null;
  }

  const db = await openFieldReadyDb();
  await db.put(BOOTSTRAP_STORE, {
    key: BOOTSTRAP_CACHE_KEY,
    data,
    cached_at: new Date().toISOString(),
  });
  return data;
}
