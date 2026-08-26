import { Shield } from "lucide-react";
import { AdminLogoutButton } from "./_components/admin-logout-button";

/*
 * Platform-admin shell — deliberately visually distinct from
 * OfficeLayout (dark zinc-950 + amber accent vs. office's zinc-900 +
 * cyan) so a screenshot or a glance at an open tab is never ambiguous
 * about which surface — a real tenant's back office, or FieldReady's own
 * operator console — is on screen. No nav tabs yet (one page, tenant
 * onboarding); add a tab row here the same way OfficeNav does once a
 * second /admin/* page exists.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="bg-black border-b border-zinc-800">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Shield className="w-4 h-4 text-amber-500" strokeWidth={2.5} />
            <span className="font-mono font-bold uppercase tracking-wider text-sm text-white">
              FieldReady Admin
            </span>
          </div>
          <AdminLogoutButton />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-5">{children}</main>
    </div>
  );
}
