/*
 * Platform-admin home — tenant onboarding, the UI replacement for running
 * apps/api/supabase/provision-tenant.mjs by hand. schema.sql §2b's own
 * platform_admin_read_all_tenants RLS policy is what makes the tenant list
 * below possible as a plain `.from("tenant")` read — no new backend route
 * needed for it, only for the actual create (routes/platform-admin.ts,
 * needs the service_role Admin API to create the first office user).
 *
 * The analytics strip (compliance-profile mix, job status mix) is the
 * cross-tenant read half of the "superadmin dashboard" ask — its own
 * additive job_platform_admin_read policy (schema.sql, applied live via
 * apply-admin-analytics.mjs) is what lets this read every tenant's job
 * rows here, same pattern as the tenant read above. Tallied in plain JS
 * from the fetched rows rather than a SQL aggregate/RPC — the row counts
 * involved are small (this is an internal operator console, not a
 * customer-facing report over millions of rows) and a plain read keeps
 * this consistent with the "RPC only when atomicity or server-side
 * attribution genuinely requires one" rule everywhere else in this app;
 * neither applies to a read-only count.
 */

import { Building2, BarChart3 } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { OnboardTenantForm } from "./_components/onboard-tenant-form";

const COMPLIANCE_LABEL: Record<string, string> = {
  basic: "Básico",
  ited_ready: "ITED pronto",
  ited_full: "ITED completo",
};

const JOB_STATUS_LABEL: Record<string, string> = {
  ready_check: "Verificação",
  dispatched: "Despachado",
  in_progress: "Em curso",
  testing: "Em teste",
  closed: "Fechado",
  cancelled: "Cancelado",
};

function tally(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((acc, v) => {
    acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
}

export default async function AdminPage() {
  const supabase = await createSupabaseServerClient();
  const { data: tenants, error } = await supabase
    .from("tenant")
    .select("id, name, slug, compliance_profile, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: jobs, error: jobsError } = await supabase.from("job").select("status");
  if (jobsError) throw jobsError;

  const complianceCounts = tally((tenants ?? []).map((t) => t.compliance_profile));
  const jobStatusCounts = tally((jobs ?? []).map((j) => j.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-white">Empresas</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Criar uma nova empresa cliente e o respetivo primeiro utilizador do escritório.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4" />
            Empresas por perfil ({tenants?.length ?? 0})
          </h2>
          <dl className="mt-2 space-y-1">
            {Object.entries(complianceCounts).map(([profile, count]) => (
              <div key={profile} className="flex items-center justify-between text-sm">
                <dt className="text-zinc-400">{COMPLIANCE_LABEL[profile] ?? profile}</dt>
                <dd className="font-mono text-zinc-100">{count}</dd>
              </div>
            ))}
            {Object.keys(complianceCounts).length === 0 && (
              <div className="text-sm text-zinc-500">Sem dados.</div>
            )}
          </dl>
        </div>

        <div className="rounded border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4" />
            Trabalhos por estado ({jobs?.length ?? 0})
          </h2>
          <dl className="mt-2 space-y-1">
            {Object.entries(jobStatusCounts).map(([status, count]) => (
              <div key={status} className="flex items-center justify-between text-sm">
                <dt className="text-zinc-400">{JOB_STATUS_LABEL[status] ?? status}</dt>
                <dd className="font-mono text-zinc-100">{count}</dd>
              </div>
            ))}
            {Object.keys(jobStatusCounts).length === 0 && (
              <div className="text-sm text-zinc-500">Sem dados.</div>
            )}
          </dl>
        </div>
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
