import { Radio } from "lucide-react";
import { LogoutButton } from "./_components/logout-button";
import { OfficeNav } from "./_components/office-nav";

/*
 * Office shell — desktop chrome for the back-office UI. Structure ported
 * from fieldready-prototype.jsx's <header> (dark zinc-900 bar, cyan
 * wordmark accent, tab row) rather than reinvented — see CLAUDE.md:
 * "treat its interaction design as settled."
 *
 * Tenant name: there is no route in apps/api that returns the tenant's
 * name (checked apps/api/src/routes/*.ts — no GET /me, /whoami, or
 * tenant-scoped read) so, per the build task's own instruction, it's
 * omitted here rather than inventing a route.
 *
 * Nav tab list + active-tab highlighting live in OfficeNav, a Client
 * Component leaf (this layout stays a Server Component) — see that file
 * for why the item list is defined there instead of passed down as props.
 *
 * print:hidden on the header — added for cost-summary/page.tsx's printed/
 * saved-PDF output (no reason the app chrome should appear in a document
 * an office user hands to a client), but applies to printing any /office
 * page, which is the right default everywhere, not just there.
 */

export default function OfficeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="bg-zinc-900 text-white print:hidden">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Radio className="w-4 h-4 text-cyan-400" strokeWidth={2.5} />
            <span className="font-mono font-bold uppercase tracking-wider text-sm">
              FieldReady
            </span>
            <span className="text-xs text-zinc-500 font-mono hidden sm:inline">
              / antenas &amp; telecom
            </span>
          </div>
          <LogoutButton />
        </div>
        <OfficeNav />
      </header>

      <main className="max-w-6xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
