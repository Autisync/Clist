/*
 * Office Dashboard — default `/office` landing page.
 *
 * There is NO `/api/dashboard/*` route yet — the first-time-fix rate, hours
 * variance, material overrun, and price-alert stats in
 * fieldready-prototype.jsx's <Dashboard> all read from that phase's mock
 * `HISTORY`/`PRICES` arrays (07-phase4-cost-intelligence.md: those are the
 * `v_first_time_fix_rate` / `v_hours_variance` / price-alert views, Phase 4
 * scope, not built yet). Nothing on this page is fabricated to fill that
 * gap — everything above the placeholder card is derived honestly from
 * routes that exist today: GET /jobs and, per active job, GET
 * /jobs/:id/readiness. That's exactly the "core insight" data the prototype
 * already has plumbing for (job.checklist / `readiness()`), just without
 * the rework-correlation numbers Phase 4 adds on top.
 *
 * Structure/tone ported from the prototype's <Dashboard>: <Stat> grid,
 * <Section> cards, and the "A precisar de atenção antes do despacho" list
 * (a button per blocked job, arrow-out to the job). No recharts here (not
 * an apps/web dependency, and everything below is simple counts, not a
 * time series) — status-count bars are done with plain flexbox, same
 * device the prototype itself uses for "Causas-raiz de retrabalho".
 */

import Link from "next/link";
import {
  LayoutDashboard,
  Briefcase,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Info,
} from "lucide-react";
import { serverApiFetch } from "@/lib/api";
import { Pill, jobStatusLabel, type PillTone } from "./_components/pill";

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

// Same shape/caveat as apps/web/src/app/office/jobs/page.tsx's Readiness
// type: v_job_readiness's counts can arrive as numeric strings depending on
// pg driver type parsing, and readiness_pct is null when a job has zero
// mandatory checklist items (nullif divide-by-zero) — coerce defensively.
type Readiness = {
  job_id: string;
  mandatory_total: number | string;
  mandatory_ok: number | string;
  readiness_pct: number | string | null;
};

type Client = { id: string; name: string };

// Statuses for which readiness is a meaningful, live signal — mirrors
// apps/web/src/app/office/jobs/page.tsx's READINESS_RELEVANT exactly (a
// closed/cancelled job's checklist state isn't "blocking" anything anymore).
const READINESS_RELEVANT = new Set(["ready_check", "dispatched", "in_progress", "testing"]);

// Display order for the status-breakdown section — job lifecycle order, not
// alphabetical, so the bars read left-to-right as the job progresses.
const STATUS_ORDER = ["ready_check", "dispatched", "in_progress", "testing", "closed", "cancelled"];

function Stat({
  label,
  value,
  sub,
  tone = "zinc",
  icon: Icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  tone?: "zinc" | "green" | "amber" | "red";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const tones: Record<string, string> = {
    zinc: "border-zinc-200",
    green: "border-green-300",
    red: "border-red-300",
    amber: "border-amber-300",
  };
  return (
    <div className={`bg-white rounded border ${tones[tone]} p-4`}>
      <div className="flex items-start justify-between">
        <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">{label}</span>
        <Icon className="w-4 h-4 text-zinc-400" />
      </div>
      <div className="mt-2">
        <span className="text-2xl font-mono font-semibold tabular-nums text-zinc-900">{value}</span>
      </div>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded border border-zinc-200">
      <div className="px-4 py-3 border-b border-zinc-100">
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {desc && <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const [{ jobs }, { clients }] = await Promise.all([
    serverApiFetch<{ jobs: Job[] }>("/jobs"),
    serverApiFetch<{ clients: Client[] }>("/clients"),
  ]);

  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  const activeJobs = jobs.filter((j) => READINESS_RELEVANT.has(j.status));
  const readinessEntries = await Promise.all(
    activeJobs.map(async (j) => {
      try {
        const r = await serverApiFetch<Readiness>(`/jobs/${j.id}/readiness`);
        return [j.id, r] as const;
      } catch {
        return [j.id, null] as const;
      }
    })
  );
  const readinessByJob = new Map(readinessEntries);

  // "cleared" mirrors jobs/page.tsx exactly: mandatory_ok === mandatory_total
  // handles the zero-mandatory-items case correctly too (0 === 0 → cleared),
  // where readiness_pct itself would be null (nullif divide-by-zero).
  const withReadiness = activeJobs
    .map((j) => ({ job: j, r: readinessByJob.get(j.id) ?? null }))
    .filter((x): x is { job: Job; r: Readiness } => x.r !== null);

  const clearedJobs = withReadiness.filter((x) => Number(x.r.mandatory_ok) === Number(x.r.mandatory_total));
  const blockedJobs = withReadiness
    .filter((x) => Number(x.r.mandatory_ok) !== Number(x.r.mandatory_total))
    .sort((a, b) => {
      if (!a.job.scheduled_at) return 1;
      if (!b.job.scheduled_at) return -1;
      return a.job.scheduled_at.localeCompare(b.job.scheduled_at);
    });

  const statusCounts = STATUS_ORDER.map((status) => ({
    status,
    count: jobs.filter((j) => j.status === status).length,
    ...jobStatusLabel(status),
  }));
  const maxStatusCount = Math.max(1, ...statusCounts.map((s) => s.count));

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <LayoutDashboard className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Dashboard</h1>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Trabalhos totais" value={jobs.length} icon={Briefcase} />
        <Stat
          label="Trabalhos ativos"
          value={activeJobs.length}
          sub="pré-despacho → testes"
          icon={Clock}
        />
        <Stat
          label="Readiness 100%"
          value={clearedJobs.length}
          sub={`de ${withReadiness.length} trabalhos ativos`}
          tone="green"
          icon={CheckCircle2}
        />
        <Stat
          label="Trabalhos bloqueados"
          value={blockedJobs.length}
          sub="readiness incompleto"
          tone={blockedJobs.length ? "amber" : "green"}
          icon={AlertTriangle}
        />
      </div>

      <Section title="Trabalhos por estado" desc="Contagem atual de GET /jobs">
        <div className="space-y-2">
          {statusCounts.map((s) => (
            <div key={s.status} className="flex items-center gap-3">
              <div className="w-32 shrink-0">
                <Pill tone={s.tone as PillTone}>{s.label}</Pill>
              </div>
              <div className="flex-1 bg-zinc-100 rounded h-5 overflow-hidden">
                <div
                  className="bg-zinc-700 h-full"
                  style={{ width: `${(s.count / maxStatusCount) * 100}%` }}
                />
              </div>
              <div className="w-6 text-xs text-zinc-600 text-right font-mono tabular-nums">
                {s.count}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="A precisar de atenção antes do despacho"
        desc="Trabalhos ativos cujo readiness ainda não está completo"
      >
        {blockedJobs.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-green-700">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            Sem trabalhos bloqueados — readiness completo em todos os trabalhos ativos.
          </div>
        ) : (
          <div className="space-y-2">
            {blockedJobs.map(({ job, r }) => {
              const missing = Number(r.mandatory_total) - Number(r.mandatory_ok);
              return (
                <Link
                  key={job.id}
                  href={`/office/jobs/${job.id}`}
                  className="w-full flex items-center justify-between p-2.5 border border-amber-200 bg-amber-50 rounded hover:bg-amber-100 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-900">
                      <span className="font-mono tabular-nums">{job.code}</span> ·{" "}
                      {clientName.get(job.client_id) || "Cliente desconhecido"} — {job.job_type}
                    </div>
                    <div className="text-xs text-zinc-600 mt-0.5 font-mono tabular-nums">
                      {job.scheduled_at
                        ? new Date(job.scheduled_at).toLocaleString("pt-PT")
                        : "Sem data agendada"}{" "}
                      · {missing} {missing === 1 ? "item em falta" : "itens em falta"}
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
                </Link>
              );
            })}
          </div>
        )}
      </Section>

      <div className="bg-white rounded border border-dashed border-zinc-300 p-4">
        <div className="flex items-start gap-3">
          <Info className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-700">Métricas de negócio</h3>
            <p className="text-xs text-zinc-500 mt-1">
              First-time-fix, desvio de tempo, derrapagem de material e alertas de preço
              chegam na Fase 4 — dependem de <code className="font-mono">v_first_time_fix_rate</code>,{" "}
              <code className="font-mono">v_hours_variance</code> e do histórico de preços, e o
              PRD é explícito: os números só significam alguma coisa a partir de ~30 trabalhos
              fechados reais. Nada aqui é inventado entretanto.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
