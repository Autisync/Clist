import { OutboxSync } from "@/components/field/OutboxSync";
import { SyncStatus } from "@/components/field/SyncStatus";

/*
 * Field shell — full-bleed mobile chrome for the technician phone UI. No
 * desktop nav bar: the phone flow is a stack of full-screen views
 * (PhonePage in fieldready-prototype.jsx pushes/pops its own header with a
 * back chevron + title per screen), not a tabbed app shell. This layout
 * only provides the full-height, no-scroll-bleed frame every /field/*
 * screen renders inside; individual screens own their own header/back
 * button per the prototype's PhonePage pattern.
 *
 * Tap targets on phone-facing screens must stay >= 56px (h-14/py-4) per
 * CLAUDE.md — that's enforced screen-by-screen, not here.
 *
 * <OutboxSync /> mounts the offline-queue background sync loop (online
 * event + 15s interval, src/components/field/OutboxSync.tsx) once for the
 * whole /field/* session. It renders nothing.
 *
 * <SyncStatus /> is the persistent pending-count indicator (task 6, this
 * stage) — a small fixed-position pill, mounted once here so it's visible
 * on every /field/* screen without any individual page having to render it
 * itself.
 */
export default function FieldLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-screen w-screen overflow-hidden bg-zinc-900 text-zinc-900">
      <OutboxSync />
      <div className="flex flex-col h-full bg-white mx-auto max-w-md relative">
        <SyncStatus />
        {children}
      </div>
    </div>
  );
}
