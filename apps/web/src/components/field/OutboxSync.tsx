"use client";

/*
 * Background sync loop for the offline outbox (src/lib/offline-queue.ts).
 * Renders nothing — mounted once in field/layout.tsx so it runs for the
 * whole /field/* session regardless of which screen is showing.
 *
 * Fires flushQueue() on two triggers, per architecture §4 Option B:
 *   - the browser "online" event (regained connectivity — flush right away
 *     rather than waiting out the rest of the interval)
 *   - a 15-second interval while the tab is open (catches the case where
 *     the tab never sees an "online" event at all — e.g. it was already
 *     online when a mutation was queued, or connectivity flapped without
 *     the browser firing the event reliably)
 *
 * flushQueue() is itself a no-op when the outbox is empty and never throws
 * (see its own doc comment), so firing it opportunistically here is safe —
 * there's no state to manage beyond "did the interval/event fire".
 */

import { useEffect } from "react";
import { flushQueue } from "@/lib/offline-queue";

const FLUSH_INTERVAL_MS = 15_000;

export function OutboxSync() {
  useEffect(() => {
    // Attempt a flush on mount too — covers the case where mutations were
    // queued in a previous session (tab closed, app killed) and the device
    // is already online when the field app is reopened.
    void flushQueue();

    function handleOnline() {
      void flushQueue();
    }

    window.addEventListener("online", handleOnline);
    const interval = setInterval(() => {
      void flushQueue();
    }, FLUSH_INTERVAL_MS);

    return () => {
      window.removeEventListener("online", handleOnline);
      clearInterval(interval);
    };
  }, []);

  return null;
}

export default OutboxSync;
