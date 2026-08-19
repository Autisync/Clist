/*
 * Offline outbox — architecture §4 Option B: local outbox + background sync
 * loop, client-generated mutation ids. This is the client-side half of the
 * wire contract apps/api/src/routes/sync.ts already implements and proves
 * idempotent over real HTTP (POST /sync/mutations, keyed on
 * client_mutation_id; applied/already_applied/rejected per mutation).
 *
 * One IndexedDB database, "fieldready-outbox", holds two object stores:
 *   - "mutations": the outbox itself (this file).
 *   - "bootstrap-cache": the read-side snapshot cache (./bootstrap-cache.ts
 *     reuses `openFieldReadyDb` below rather than opening a second database,
 *     so there's exactly one place that owns the DB name/version/upgrade).
 *
 * enqueueMutation() is the only function on the write path a UI ever calls
 * directly — it must never await a network call, so it works with zero
 * connectivity. flushQueue() is what actually talks to the network, called
 * opportunistically (online event, a 15s interval, or manually) by
 * components/field/OutboxSync.tsx.
 */

import { useSyncExternalStore } from "react";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SyncMutation, SyncMutationResult, SyncMutationsResponse } from "@fieldready/core";
import { apiFetch } from "./api";

export type OutboxStatus = "pending" | "synced" | "failed";

// Every row is a real SyncMutation (same discriminated union the API
// validates against) plus local queue bookkeeping. Keeping the mutation
// shape byte-identical to the wire contract means flushQueue() can post
// queued rows straight through with no reshaping.
export type OutboxMutation = SyncMutation & {
  status: OutboxStatus;
  reason?: string;
};

// What a caller hands to enqueueMutation() — everything except the fields
// this module generates itself (client_mutation_id, occurred_at) and the
// queue-only status/reason fields.
export type MutationInput = Omit<SyncMutation, "client_mutation_id" | "occurred_at">;

interface FieldReadyDB extends DBSchema {
  mutations: {
    key: string;
    value: OutboxMutation;
    indexes: { "by-status": OutboxStatus };
  };
  "bootstrap-cache": {
    key: string;
    value: { key: string; data: unknown; cached_at: string };
  };
}

const DB_NAME = "fieldready-outbox";
const DB_VERSION = 1;
export const MUTATIONS_STORE = "mutations";
export const BOOTSTRAP_STORE = "bootstrap-cache";

let dbPromise: Promise<IDBPDatabase<FieldReadyDB>> | null = null;

/**
 * Opens (creating/upgrading if needed) the shared fieldready-outbox
 * database. Exported so bootstrap-cache.ts can reuse the same database
 * instead of standing up a second one with its own version to track.
 */
export function openFieldReadyDb(): Promise<IDBPDatabase<FieldReadyDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FieldReadyDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(MUTATIONS_STORE)) {
          const store = db.createObjectStore(MUTATIONS_STORE, {
            keyPath: "client_mutation_id",
          });
          store.createIndex("by-status", "status");
        }
        if (!db.objectStoreNames.contains(BOOTSTRAP_STORE)) {
          db.createObjectStore(BOOTSTRAP_STORE, { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

// --- pub/sub for UI status (pending count + syncing flag) --------------
//
// A minimal event emitter so components can react to outbox state changes
// without polling IndexedDB on a timer. useOutboxStatus() below is the
// React-friendly wrapper most components should use; subscribeOutbox() is
// the raw primitive underneath it.

type Listener = () => void;
const listeners = new Set<Listener>();
let cachedPending = 0;
let cachedSyncing = false;

function emit(): void {
  for (const listener of listeners) listener();
}

async function refreshPendingCount(): Promise<void> {
  try {
    cachedPending = await pendingCount();
  } catch {
    // IndexedDB unavailable (SSR, private-browsing lockdown, etc.) — leave
    // the last-known count in place rather than throwing.
  }
  emit();
}

function setSyncing(value: boolean): void {
  cachedSyncing = value;
  emit();
}

/**
 * Subscribe to outbox state changes (pending count and syncing flag).
 * Returns an unsubscribe function. Triggers an initial count refresh when
 * the first listener subscribes, so a freshly-mounted UI doesn't show a
 * stale zero before anything else happens.
 */
export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshPendingCount();
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React hook: { pending, syncing } for a UI indicator (e.g. a small badge
 * in the field app chrome). Backed by the same pub/sub subscribeOutbox()
 * uses, so it updates without polling.
 */
export function useOutboxStatus(): { pending: number; syncing: boolean } {
  const pending = useSyncExternalStore(
    subscribeOutbox,
    () => cachedPending,
    () => 0
  );
  const syncing = useSyncExternalStore(
    subscribeOutbox,
    () => cachedSyncing,
    () => false
  );
  return { pending, syncing };
}

// --- queue operations ----------------------------------------------------

/**
 * Enqueue a mutation for later sync. Generates client_mutation_id and
 * occurred_at, writes a "pending" row to IndexedDB, and returns it.
 *
 * MUST NOT await any network call — this is the function screens call the
 * instant the technician taps a button, offline or not, and it has to
 * return immediately regardless of connectivity.
 */
export async function enqueueMutation(input: MutationInput): Promise<OutboxMutation> {
  const row = {
    ...input,
    client_mutation_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    status: "pending" as const,
  } as OutboxMutation;

  const db = await openFieldReadyDb();
  await db.put(MUTATIONS_STORE, row);

  void refreshPendingCount();
  return row;
}

/**
 * Current count of "pending" rows, for a UI indicator. Prefer
 * useOutboxStatus() inside a component (it doesn't re-hit IndexedDB on
 * every render); this is the raw one-shot read it's built on.
 */
export async function pendingCount(): Promise<number> {
  const db = await openFieldReadyDb();
  return db.countFromIndex(MUTATIONS_STORE, "by-status", "pending");
}

/**
 * Flush all pending mutations to the API in one batch (POST
 * /sync/mutations), then reconcile each row by the server's per-mutation
 * result: applied/already_applied -> "synced", rejected -> "failed" with
 * the reason. A network failure (offline, timeout, non-2xx from apiFetch)
 * is caught here and leaves every row untouched as "pending" for the next
 * attempt — this function must never throw up past itself.
 */
export async function flushQueue(): Promise<void> {
  const db = await openFieldReadyDb();
  const pending = await db.getAllFromIndex(MUTATIONS_STORE, "by-status", "pending");
  if (pending.length === 0) return;

  setSyncing(true);
  try {
    let response: SyncMutationsResponse;
    try {
      response = await apiFetch<SyncMutationsResponse>("/sync/mutations", {
        method: "POST",
        body: JSON.stringify({
          mutations: pending.map(({ status: _status, reason: _reason, ...mutation }) => mutation),
        }),
      });
    } catch {
      // Offline, timed out, or the server rejected the batch outright —
      // leave every row "pending" so the next flush (online event, 15s
      // interval, or manual retry) picks them back up unchanged.
      return;
    }

    const byId = new Map<string, SyncMutationResult>(
      response.results.map((r) => [r.client_mutation_id, r])
    );

    const tx = db.transaction(MUTATIONS_STORE, "readwrite");
    for (const row of pending) {
      const result = byId.get(row.client_mutation_id);
      if (!result) continue; // server didn't report on this one; leave pending
      if (result.status === "applied" || result.status === "already_applied") {
        await tx.store.put({ ...row, status: "synced", reason: undefined });
      } else {
        await tx.store.put({ ...row, status: "failed", reason: result.reason });
      }
    }
    await tx.done;
  } finally {
    setSyncing(false);
    void refreshPendingCount();
  }
}
