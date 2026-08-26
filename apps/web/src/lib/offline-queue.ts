/*
 * Offline outbox — architecture §4 Option B: local outbox + background sync
 * loop, client-generated mutation ids.
 *
 * Technician-auth migration (08-supabase-native-migration.md §2):
 * flushQueue() now calls each pending mutation's own already-proven RPC
 * directly (supabase.rpc(...)) instead of POSTing the whole batch to the
 * classic system's POST /sync/mutations — a real, easy-to-miss consistency
 * risk this file's own previous version would have hit the moment any
 * field page's READS moved to Supabase-native public.job while its WRITES
 * kept landing in the classic system's own, completely separate schema:
 * every mutation would have "succeeded" (200 from a real, working, but
 * disconnected endpoint) while doing nothing to the data any read path
 * (technician's own or the office's) actually shows. applyMutation() below
 * maps each of the five mutation types to the exact RPC + parameter names
 * apps/web/src/app/office/jobs/[id]/_components/job-detail.tsx already
 * calls and already has proven (rpc_checklist_item_update,
 * rpc_execution_step_complete, rpc_test_result_record, rpc_closeout_submit,
 * rpc_van_audit_record) — reusing those exact shapes rather than
 * re-deriving them from packages/core's Zod schemas independently, so any
 * future drift between the two call sites is one to notice, not two to
 * keep in sync by hand.
 *
 * Each mutation is its own RPC call now, not one atomic batch — the same
 * per-mutation independence apps/api/src/routes/sync.ts's own batch
 * handler already had (one rejected mutation in a batch never blocked the
 * others), just without the batching itself.
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
import type { SyncMutation, SyncMutationResult } from "@fieldready/core";
import { createSupabaseBrowserClient } from "./supabase/client";

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

// Maps one queued mutation to its already-proven RPC call — see file
// header comment for why these exact parameter names, not re-derived from
// packages/core's Zod schemas. Throws (network/unexpected error) rather
// than returning a result when the call itself failed to complete at all
// (offline, timeout) — flushQueue()'s per-row try/catch below is what
// leaves that row "pending" for the next attempt; a real rejection from
// the RPC itself (e.g. a validation failure) comes back as a normal
// {status: "rejected", reason} result, not a thrown error, same
// distinction apps/api/src/routes/sync.ts's own applied_mutation results
// already draw.
async function applyMutation(mutation: SyncMutation): Promise<SyncMutationResult> {
  const supabase = createSupabaseBrowserClient();
  const { client_mutation_id, job_id } = mutation;

  const { data, error } = await (() => {
    switch (mutation.type) {
      case "checklist_item.update":
        return supabase.rpc("rpc_checklist_item_update", {
          p_client_mutation_id: client_mutation_id,
          p_job_id: job_id,
          p_item_id: mutation.payload.item_id,
          p_status: mutation.payload.status,
        });
      case "execution_step.complete":
        return supabase.rpc("rpc_execution_step_complete", {
          p_client_mutation_id: client_mutation_id,
          p_job_id: job_id,
          p_step: mutation.payload.step,
        });
      case "test_result.record":
        return supabase.rpc("rpc_test_result_record", {
          p_client_mutation_id: client_mutation_id,
          p_job_id: job_id,
          p_network_type: mutation.payload.network_type,
          p_location_label: mutation.payload.location_label,
          p_test_code: mutation.payload.test_code,
          p_measured_value: mutation.payload.measured_value,
          p_unit: mutation.payload.unit ?? null,
          p_limit_ref: mutation.payload.limit_ref ?? null,
          p_capture_source: mutation.payload.capture_source,
          p_raw_capture_file: mutation.payload.raw_capture_file ?? null,
          p_instrument_id: mutation.payload.instrument_id ?? null,
        });
      case "closeout.submit":
        return supabase.rpc("rpc_closeout_submit", {
          p_client_mutation_id: client_mutation_id,
          p_job_id: job_id,
          p_first_time_fix: mutation.payload.first_time_fix,
          p_technician_voice_note_file: mutation.payload.technician_voice_note_file ?? null,
          p_technician_note_transcript: mutation.payload.technician_note_transcript,
          p_client_signature_file: mutation.payload.client_signature_file ?? null,
        });
      case "van_audit.record":
        return supabase.rpc("rpc_van_audit_record", {
          p_client_mutation_id: client_mutation_id,
          p_van_label: mutation.payload.van_label,
          p_issues: mutation.payload.issues,
        });
    }
  })();

  if (error) throw error;
  return data as SyncMutationResult;
}

/**
 * Flush all pending mutations, each via its own RPC call (see file header
 * comment for why this replaced one batch POST), then reconcile each row
 * by its own result: applied/already_applied -> "synced", rejected ->
 * "failed" with the reason. A row whose RPC call itself failed to complete
 * (offline, timeout, unexpected error) is left "pending" for the next
 * attempt — this function must never throw up past itself.
 */
export async function flushQueue(): Promise<void> {
  const db = await openFieldReadyDb();
  const pending = await db.getAllFromIndex(MUTATIONS_STORE, "by-status", "pending");
  if (pending.length === 0) return;

  setSyncing(true);
  try {
    for (const row of pending) {
      const { status: _status, reason: _reason, ...mutation } = row;
      let result: SyncMutationResult;
      try {
        result = await applyMutation(mutation);
      } catch {
        // Leave this row "pending" — the next flush (online event, 15s
        // interval, or manual retry) picks it back up unchanged. Other
        // rows in this same pass are unaffected (per-row try/catch).
        continue;
      }
      if (result.status === "applied" || result.status === "already_applied") {
        await db.put(MUTATIONS_STORE, { ...row, status: "synced", reason: undefined });
      } else {
        await db.put(MUTATIONS_STORE, { ...row, status: "failed", reason: result.reason });
      }
    }
  } finally {
    setSyncing(false);
    void refreshPendingCount();
  }
}
