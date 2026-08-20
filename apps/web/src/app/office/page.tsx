/*
 * Office Dashboard — default `/office` landing page.
 *
 * Phase 4 (07-phase4-cost-intelligence.md): the business-metrics card that
 * used to say "coming in Phase 4" is now wired to the five real
 * `/api/dashboard/*` endpoints, which are thin reads over `03-schema.sql`
 * §13/§13a's views — nothing computed here is hardcoded or fabricated.
 * Structure ported from fieldready-prototype.jsx's <Dashboard>: the Stat
 * grid, the readiness-correlation headline insight box, two chart sections
 * (hours variance by job type, first-time-fix trend), the price-alerts
 * list, and the recommended-actions list. No recharts here (not an
 * apps/web dependency — see the build task) — both charts are plain
 * flexbox bars, the same device this page already used for its job-status
 * breakdown.
 *
 * CLAUDE.md / PRD: the dashboard's *numbers* are real as of this wiring,
 * but the project's own gate is on trusting the dashboard's *conclusions*
 * until 30+ real closed jobs exist — that's a data-volume fact, not a
 * reason to withhold the code path, so small-sample sections say so
 * plainly instead of hiding the (accurate) numbers.
 */

import Link from "next/link";
import {
  LayoutDashboard,
  Briefcase,
  Clock,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  TrendingUp,
  TrendingDown,
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

type FfrMonth = {
  month: string;
  jobs_closed: number | null;
  first_time_fixes: number | null;
  ffr_pct: number | null;
};

type HoursVarianceRow = {
  job_type: string;
  n: number | null;
  avg_hours_delta: number | null;
  avg_pct_variance: number | null;
};

type ReadinessBucket = {
  readiness_bucket: "gated" | "ungated";
  jobs: number | null;
  rework_jobs: number | null;
  rework_pct: number | null;
};

type PriceAlert = {
  item_id: string;
  item_name: string;
  item_sku: string;
  supplier_id: string;
  supplier_name: string;
  price: number;
  prev_price: number;
  delta_pct: number;
  alt: { supplier_id: string; supplier_name: string; price: number } | null;
};

type RecommendedAction = { priority: "Alta" | "Média" | "Baixa"; title: string; why: string };

// Statuses for which readiness is a meaningful, live signal — mirrors
// apps/web/src/app/office/jobs/page.tsx's READINESS_RELEVANT exactly (a
// closed/cancelled job's checklist state isn't "blocking" anything anymore).
const READINESS_RELEVANT = new Set(["ready_check", "dispatched", "in_progress", "testing"]);

// Display order for the status-breakdown section — job lifecycle order, not
// alphabetical, so the bars read left-to-right as the job progresses.
const STATUS_ORDER = ["ready_check", "dispatched", "in_progress", "testing", "closed", "cancelled"];

const eur = (n: number) => `€${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n)}%`;

const ACTION_TONE: Record<RecommendedAction["priority"], PillTone> = {
  Alta: "red",
  Média: "amber",
  Baixa: "zinc",
};

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
  right,
  children,
}: {
  title: string;
  desc?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded border border-zinc-200">
      <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
          {desc && <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>}
        </div>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const [
    { jobs },
    { clients },
    ffrResult,
    hoursResult,
    correlationResult,
    priceAlertsResult,
    actionsResult,
  ] = await Promise.all([
    serverApiFetch<{ jobs: Job[] }>("/jobs"),
    serverApiFetch<{ clients: Client[] }>("/clients"),
    serverApiFetch<{ months: FfrMonth[] }>("/dashboard/first-time-fix-rate?months=6"),
    serverApiFetch<{ by_job_type: HoursVarianceRow[] }>("/dashboard/hours-variance?by=job_type"),
    serverApiFetch<{ buckets: ReadinessBucket[] }>("/dashboard/readiness-correlation"),
    serverApiFetch<{ alerts: PriceAlert[] }>("/dashboard/price-alerts"),
    serverApiFetch<{ actions: RecommendedAction[] }>("/dashboard/recommended-actions"),
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

  // Overall FFR across the window: sum, not average-of-averages, so a
  // sparse month doesn't get equal weight to a busy one.
  const ffrMonths = ffrResult.months;
  const totalClosed = ffrMonths.reduce((a, m) => a + (m.jobs_closed ?? 0), 0);
  const totalFirstFix = ffrMonths.reduce((a, m) => a + (m.first_time_fixes ?? 0), 0);
  const overallFfr = totalClosed > 0 ? (100 * totalFirstFix) / totalClosed : null;
  const maxFfrPct = Math.max(1, ...ffrMonths.map((m) => m.ffr_pct ?? 0));
  const prevMonthFfr = ffrMonths.length >= 2 ? ffrMonths[ffrMonths.length - 2].ffr_pct : null;
  const lastMonthFfr = ffrMonths.length >= 1 ? ffrMonths[ffrMonths.length - 1].ffr_pct : null;
  const ffrTrendPp =
    lastMonthFfr !== null && prevMonthFfr !== null ? Math.round(lastMonthFfr - prevMonthFfr) : null;

  // Weighted overall time variance (weighted by job count per type) — same
  // spirit as the prototype's single HISTORY-wide average, computed here
  // from the real per-job_type view instead of a flat history array.
  const byType = hoursResult.by_job_type;
  const totalHoursJobs = byType.reduce((a, r) => a + (r.n ?? 0), 0);
  const weightedPctVariance =
    totalHoursJobs > 0
      ? byType.reduce((a, r) => a + (r.avg_pct_variance ?? 0) * (r.n ?? 0), 0) / totalHoursJobs
      : null;
  const worstType = byType.length > 0 ? byType[0] : null;
  const maxAbsVariance = Math.max(1, ...byType.map((r) => Math.abs(r.avg_pct_variance ?? 0)));

  const gated = correlationResult.buckets.find((b) => b.readiness_bucket === "gated") ?? null;
  const ungated = correlationResult.buckets.find((b) => b.readiness_bucket === "ungated") ?? null;

  const alerts = priceAlertsResult.alerts;
  const actions = actionsResult.actions;

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="First-time fix"
          value={overallFfr === null ? "—" : pct(overallFfr)}
          sub={
            overallFfr === null
              ? "Sem trabalhos fechados nos últimos 6 meses"
              : `Meta 90% · ${totalClosed} trabalho${totalClosed === 1 ? "" : "s"} fechado${totalClosed === 1 ? "" : "s"}`
          }
          tone={overallFfr === null ? "zinc" : overallFfr >= 90 ? "green" : overallFfr >= 75 ? "amber" : "red"}
          icon={CheckCircle2}
        />
        <Stat
          label="Desvio de tempo"
          value={weightedPctVariance === null ? "—" : `${weightedPctVariance >= 0 ? "+" : ""}${Math.round(weightedPctVariance)}%`}
          sub={weightedPctVariance === null ? "Sem trabalhos com horas reais" : `${totalHoursJobs} trabalho${totalHoursJobs === 1 ? "" : "s"} com horas registadas`}
          tone={weightedPctVariance === null ? "zinc" : weightedPctVariance > 25 ? "red" : weightedPctVariance > 10 ? "amber" : "green"}
          icon={Clock}
        />
        <Stat
          label="Alertas de preço"
          value={alerts.length}
          sub="subidas &gt;3% desde o último preço"
          tone={alerts.length ? "amber" : "green"}
          icon={TrendingUp}
        />
        <Stat
          label="Ações recomendadas"
          value={actions.length}
          sub={actions.filter((a) => a.priority === "Alta").length + " de prioridade alta"}
          tone={actions.some((a) => a.priority === "Alta") ? "red" : actions.length ? "amber" : "green"}
          icon={Info}
        />
      </div>

      {/* headline insight — readiness vs rework, the prototype's central argument */}
      {gated && ungated ? (
        <div className="bg-white rounded border-l-4 border-l-red-500 border border-zinc-200 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="text-sm font-semibold">
                Correlação entre readiness no despacho e retrabalho (first-time fix)
              </h3>
              <div className="mt-3 grid sm:grid-cols-2 gap-3">
                <div className="bg-green-50 rounded p-3">
                  <div className="text-xs text-green-800 font-medium">
                    Readiness 100% ({gated.jobs ?? 0} trabalho{(gated.jobs ?? 0) === 1 ? "" : "s"})
                  </div>
                  <div className="text-xl font-semibold text-green-900">
                    {gated.rework_pct === null ? "—" : pct(gated.rework_pct)}
                  </div>
                  <div className="text-xs text-green-700">taxa de retrabalho</div>
                </div>
                <div className="bg-red-50 rounded p-3">
                  <div className="text-xs text-red-800 font-medium">
                    Readiness &lt; 100% ({ungated.jobs ?? 0} trabalho{(ungated.jobs ?? 0) === 1 ? "" : "s"})
                  </div>
                  <div className="text-xl font-semibold text-red-900">
                    {ungated.rework_pct === null ? "—" : pct(ungated.rework_pct)}
                  </div>
                  <div className="text-xs text-red-700">taxa de retrabalho</div>
                </div>
              </div>
              <p className="mt-3 text-xs text-zinc-600">
                Calculado sobre trabalhos fechados com readiness conhecido — v_readiness_correlation.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded border border-dashed border-zinc-300 p-4">
          <div className="flex items-start gap-3">
            <Info className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
            <p className="text-xs text-zinc-500">
              Ainda não há trabalhos fechados suficientes (com readiness e first-time-fix
              registados) para calcular a correlação readiness ↔ retrabalho.
            </p>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <Section
          title="Desvio de tempo por tipo de trabalho"
          desc="Real vs. orçamentado — corrige os orçamentos aqui"
        >
          {byType.length === 0 ? (
            <p className="text-xs text-zinc-500">Sem trabalhos com horas reais registadas ainda.</p>
          ) : (
            <>
              <div className="space-y-2">
                {byType.map((r) => {
                  const v = r.avg_pct_variance ?? 0;
                  const barTone = v > 25 ? "bg-red-600" : v > 10 ? "bg-amber-500" : "bg-green-600";
                  const widthPct = (Math.abs(v) / maxAbsVariance) * 100;
                  return (
                    <div key={r.job_type} className="flex items-center gap-3">
                      <div className="w-32 shrink-0 text-xs text-zinc-700 truncate" title={r.job_type}>
                        {r.job_type}
                      </div>
                      <div className="flex-1 bg-zinc-100 rounded h-5 overflow-hidden">
                        <div className={`h-full ${barTone}`} style={{ width: `${widthPct}%` }} />
                      </div>
                      <div className="w-16 text-xs text-zinc-600 text-right font-mono tabular-nums">
                        {v >= 0 ? "+" : ""}
                        {v}%
                      </div>
                    </div>
                  );
                })}
              </div>
              {worstType && worstType.avg_pct_variance !== null && worstType.avg_pct_variance > 0 && (
                <p className="text-xs text-zinc-500 mt-2">
                  &quot;{worstType.job_type}&quot; está +{worstType.avg_pct_variance}% acima do orçamento
                  ({worstType.n} trabalho{worstType.n === 1 ? "" : "s"}). Rever o tempo-padrão.
                </p>
              )}
            </>
          )}
        </Section>

        <Section title="First-time fix — tendência" desc="Percentagem de trabalhos fechados sem segunda visita">
          {ffrMonths.length === 0 ? (
            <p className="text-xs text-zinc-500">Sem trabalhos fechados nos últimos 6 meses.</p>
          ) : (
            <>
              <div className="flex items-end gap-2 h-40">
                {ffrMonths.map((m) => {
                  const value = m.ffr_pct ?? 0;
                  const heightPct = Math.max(2, (value / Math.max(maxFfrPct, 100)) * 100);
                  return (
                    <div key={m.month} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
                      <div className="text-xs font-mono tabular-nums text-zinc-600">
                        {m.ffr_pct === null ? "—" : `${m.ffr_pct}%`}
                      </div>
                      <div
                        className={`w-full rounded-t ${value >= 90 ? "bg-green-600" : value >= 75 ? "bg-amber-500" : "bg-red-600"}`}
                        style={{ height: `${heightPct}%` }}
                      />
                      <div className="text-[10px] text-zinc-500 whitespace-nowrap">
                        {new Date(m.month).toLocaleDateString("pt-PT", { month: "short" })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {ffrTrendPp !== null && (
                <div
                  className={`mt-2 text-xs flex items-center gap-1 ${ffrTrendPp >= 0 ? "text-green-700" : "text-red-700"}`}
                >
                  {ffrTrendPp >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {ffrTrendPp >= 0 ? "+" : ""}
                  {ffrTrendPp}pp face ao mês anterior
                </div>
              )}
            </>
          )}
        </Section>
      </div>

      <Section title="Alertas de preço" desc="Subidas &gt;3% detetadas nos preços dos fornecedores">
        {alerts.length === 0 ? (
          <p className="text-xs text-zinc-500">Sem alertas de preço.</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {alerts.slice(0, 8).map((a) => (
              <div key={`${a.item_id}-${a.supplier_id}`} className="border border-zinc-200 rounded p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">{a.item_name}</div>
                    <div className="text-xs text-zinc-500">{a.supplier_name}</div>
                  </div>
                  <Pill tone="red">+{a.delta_pct.toFixed(1)}%</Pill>
                </div>
                <div className="mt-1.5 text-xs text-zinc-600">
                  {eur(a.prev_price)} → <span className="font-medium text-zinc-900">{eur(a.price)}</span>
                  {a.alt && a.alt.price < a.price && (
                    <span className="text-green-700">
                      {" "}
                      · {a.alt.supplier_name.split("—")[0].trim()} tem a {eur(a.alt.price)} (poupa{" "}
                      {eur(a.price - a.alt.price)})
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Ações recomendadas" desc="Gerado a partir dos dados acima">
        {actions.length === 0 ? (
          <p className="text-xs text-zinc-500">Sem ações recomendadas neste momento.</p>
        ) : (
          <div className="space-y-2">
            {actions.map((a, i) => (
              <div key={i} className="flex items-start gap-3 p-2.5 border border-zinc-200 rounded">
                <Pill tone={ACTION_TONE[a.priority]}>{a.priority}</Pill>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{a.title}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">{a.why}</div>
                </div>
              </div>
            ))}
          </div>
        )}
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

      <div className="bg-white rounded border border-dashed border-zinc-300 p-3">
        <div className="flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
          <p className="text-xs text-zinc-500">
            Os números acima são reais (v_first_time_fix_rate, v_hours_variance,
            v_readiness_correlation, v_price_alerts) — mas o PRD é explícito: só valem a
            pena confiar nas conclusões a partir de ~30 trabalhos fechados reais.
          </p>
        </div>
      </div>
    </div>
  );
}
