/*
 * Job list — visual structure ported from fieldready-prototype.jsx's
 * <JobList> (readiness bar, status pill, address/schedule line) per
 * CLAUDE.md ("treat its interaction design as settled"), wired to real
 * data: GET /jobs, then GET /jobs/:id/readiness per row.
 *
 * N+1 mitigation (per the build task): readiness is only meaningful
 * before/during execution, so it's only fetched for jobs whose status is
 * ready_check/dispatched/in_progress/testing — closed/cancelled jobs skip
 * the extra request entirely and just show their terminal status pill.
 *
 * There is no technician-name route (checked apps/api/src/routes/*.ts —
 * no GET that lists app_user/technicians), so assigned_to renders as a
 * short id fragment rather than a name, same "omit rather than invent a
 * route" rule as the tenant name in the layout.
 */

import Link from "next/link";
import { Briefcase, MapPin } from "lucide-react";
import { serverApiFetch } from "@/lib/api";
import { Pill, jobStatusLabel } from "../_components/pill";

type Job = {
  id: string;
  client_id: string;
  code: string;
  title: string;
  address: string | null;
  job_type: string;
  scheduled_at: string | null;
  quoted_hours: string;
  quoted_materials: string;
  assigned_to: string | null;
  status: string;
  created_at: string;
};

// mandatory_total/mandatory_ok/readiness_pct come from v_job_readiness
// (03-schema.sql — count()/round() over a left join), which can arrive as
// numeric strings depending on the pg driver's type parsing and is null
// when a job has zero mandatory checklist items (nullif divide-by-zero) —
// coerce defensively rather than assume `number`.
type Readiness = {
  job_id: string;
  mandatory_total: number | string;
  mandatory_ok: number | string;
  readiness_pct: number | string | null;
};

type Client = { id: string; name: string };

const eur = (n: string | number) => `€${Number(n).toFixed(2)}`;
const READINESS_RELEVANT = new Set(["ready_check", "dispatched", "in_progress", "testing"]);

export default async function JobsPage() {
  const [{ jobs }, { clients }] = await Promise.all([
    serverApiFetch<{ jobs: Job[] }>("/jobs"),
    serverApiFetch<{ clients: Client[] }>("/clients"),
  ]);

  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const relevant = jobs.filter((j) => READINESS_RELEVANT.has(j.status));
  const readinessEntries = await Promise.all(
    relevant.map(async (j) => {
      try {
        const r = await serverApiFetch<Readiness>(`/jobs/${j.id}/readiness`);
        return [j.id, r] as const;
      } catch {
        return [j.id, null] as const;
      }
    })
  );
  const readinessByJob = new Map(readinessEntries);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Briefcase className="w-5 h-5 text-cyan-600" />
          <h1 className="text-lg font-semibold text-zinc-900">Trabalhos</h1>
        </div>
        <Link
          href="/office/quotes/new"
          className="text-sm text-cyan-700 hover:text-cyan-800 font-medium"
        >
          Novo orçamento →
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="bg-white rounded border border-zinc-200 p-4 text-sm text-zinc-500">
          Ainda não existem trabalhos. Um trabalho é criado a partir de um orçamento aceite.
        </div>
      ) : (
        <div className="bg-white rounded border border-zinc-200 divide-y divide-zinc-100">
          {jobs.map((j) => {
            const { label, tone } = jobStatusLabel(j.status);
            const r = readinessByJob.get(j.id);
            const pct = r && r.readiness_pct != null ? Number(r.readiness_pct) : 0;
            const cleared = r ? Number(r.mandatory_ok) === Number(r.mandatory_total) : false;

            return (
              <Link
                key={j.id}
                href={`/office/jobs/${j.id}`}
                className="block p-3.5 hover:bg-zinc-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono tabular-nums text-zinc-500">{j.code}</span>
                      <Pill tone={tone}>{label}</Pill>
                    </div>
                    <div className="text-sm font-medium mt-1 text-zinc-900">
                      {clientName.get(j.client_id) || "Cliente desconhecido"} — {j.job_type}
                    </div>
                    {j.address && (
                      <div className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                        <MapPin className="w-3 h-3" />
                        {j.address}
                      </div>
                    )}
                    <div className="text-xs text-zinc-500 mt-0.5 font-mono tabular-nums">
                      {j.scheduled_at
                        ? new Date(j.scheduled_at).toLocaleString("pt-PT")
                        : "Sem data agendada"}{" "}
                      · orçamento {Number(j.quoted_hours).toFixed(1)} h / {eur(j.quoted_materials)}
                      {j.assigned_to && ` · técnico ${j.assigned_to.slice(0, 8)}`}
                    </div>
                  </div>

                  {r && (
                    <div className="text-right shrink-0">
                      <div
                        className={`text-lg font-mono font-semibold tabular-nums ${
                          cleared ? "text-green-600" : "text-amber-600"
                        }`}
                      >
                        {Math.round(pct)}%
                      </div>
                      <div className="text-xs text-zinc-500">readiness</div>
                    </div>
                  )}
                </div>

                {r && (
                  <div className="mt-2 h-1.5 bg-zinc-100 rounded overflow-hidden">
                    <div
                      className={`h-full ${cleared ? "bg-green-500" : "bg-amber-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
