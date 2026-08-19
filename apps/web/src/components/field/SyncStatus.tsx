"use client";

/*
 * Persistent sync-status pill for the technician phone chrome — this
 * stage's task 6. Mounted once in field/layout.tsx alongside <OutboxSync />
 * so it's visible on every /field/* screen regardless of which page is
 * showing, matching PRD §6's technician-trust concern: the technician must
 * always be able to see whether the office has actually received what he
 * tapped, not just that the tap "worked" locally.
 *
 * Backed by useOutboxStatus() (src/lib/offline-queue.ts), the same
 * pub/sub-driven hook OutboxSync's flush loop feeds — no separate polling.
 *
 * Rendered as a small fixed-position overlay (not part of page flow) so it
 * never disturbs the full-bleed layouts individual phone screens already
 * own (dark keypad, one-item walkthrough, full-color result states, etc.) —
 * those screens weren't designed with a persistent top bar eating into
 * their height.
 *
 * Pass/fail-style color rule (CLAUDE.md): always icon + word + color
 * together, never color alone. "Sincronizado" is green (steady state,
 * nothing owed); a nonzero pending count is amber, not red — an unsynced
 * mutation sitting in the outbox is expected/normal while offline, not a
 * failure state.
 */

import { CheckCircle2, CloudUpload } from "lucide-react";
import { useOutboxStatus } from "@/lib/offline-queue";

export function SyncStatus() {
  const { pending, syncing } = useOutboxStatus();

  const synced = pending === 0;

  return (
    <div
      className={`fixed top-2 right-2 z-50 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold shadow-sm border ${
        synced
          ? "bg-green-50 text-green-700 border-green-200"
          : "bg-amber-50 text-amber-800 border-amber-200"
      }`}
      role="status"
      aria-live="polite"
    >
      {synced ? (
        <CheckCircle2 className="w-3.5 h-3.5" />
      ) : (
        <CloudUpload className={`w-3.5 h-3.5 ${syncing ? "animate-pulse" : ""}`} />
      )}
      <span className="font-mono tabular-nums">
        {synced ? "Sincronizado" : `${pending} por sincronizar`}
      </span>
    </div>
  );
}

export default SyncStatus;
