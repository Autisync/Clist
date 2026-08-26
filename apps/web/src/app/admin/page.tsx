/*
 * Platform-admin home — tenant onboarding, the UI replacement for running
 * apps/api/supabase/provision-tenant.mjs by hand. schema.sql §2b's own
 * platform_admin_read_all_tenants RLS policy is what makes the tenant list
 * below possible as a plain `.from("tenant")` read — no new backend route
 * needed for it, only for the actual create (routes/platform-admin.ts,
 * needs the service_role Admin API to create the first office user).
 */

import { Building2 } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardTenantForm } from "./_components/onboard-tenant-form";

export default async function AdminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: tenants, error } = await supabase
    .from("tenant")
    .select("id, name, slug, compliance_profile, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-white">Empresas</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Criar uma nova empresa cliente e o respetivo primeiro utilizador do escritório.
        </p>
      </div>

      <OnboardTenantForm />

      <div>
        <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5">
          <Building2 className="w-4 h-4" />
          Empresas existentes ({tenants?.length ?? 0})
        </h2>
        <div className="mt-2 space-y-1.5">
          {(tenants ?? []).length === 0 && (
            <div className="rounded border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
              Ainda não existem empresas.
            </div>
          )}
          {(tenants ?? []).map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between gap-3 rounded border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm"
            >
              <div>
                <div className="font-medium text-zinc-100">{t.name}</div>
                <div className="text-xs text-zinc-500 font-mono">{t.slug}</div>
              </div>
              <span className="text-xs font-mono text-zinc-400 uppercase">{t.compliance_profile}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
