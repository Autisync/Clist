"use client";

/*
 * Job header + 3-stage tab shell + all three tabs' full implementation.
 * Tab structure/interaction ported from fieldready-prototype.jsx's
 * <JobDetail>/<Execution>/<AAR> (stage state, tab row, banner + section
 * layout, the CAUSES taxonomy) per CLAUDE.md — wired to real fetch calls
 * instead of the prototype's mock `onUpdate`/local-only state.
 *
 * Execução and After-action report have no GET route to hydrate prior
 * state from (no GET for job_execution_step_completion, job_photo, or
 * job_test_result rows — checked apps/api/src/routes/jobs.ts and sync.ts)
 * — so, like the prototype itself, both tabs start from an empty/untouched
 * local state and fill in as the office user works through them in this
 * session; job.status/completed_at (which the office user's earlier GET
 * /jobs/:id call already returned) is used to detect "this job already
 * passed this stage in an earlier session" and skip straight to the right
 * sub-state (e.g. show the close-out form immediately if completed_at is
 * already set) rather than re-showing controls that would just re-run
 * already-applied work.
 */

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Package,
  Wrench,
  FileText,
  Loader2,
  Camera,
  Clock,
  MinusCircle,
} from "lucide-react";
import { apiFetch, ApiError, uploadPhoto } from "@/lib/api";
import { Pill, jobStatusLabel, type PillTone } from "../../../_components/pill";
import type { ChecklistItem, Readiness, ExecutionSnapshot, TestProtocolSnapshot, TestProtocolTest } from "../page";

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
  completed_at: string | null;
  execution_snapshot: ExecutionSnapshot;
  test_protocol_snapshot: TestProtocolSnapshot;
};

// Fixed root-cause taxonomy — ported verbatim from fieldready-prototype.jsx
// (CAUSES, line 239) per this stage's task spec ("reuse the CAUSES list
// from fieldready-prototype.jsx verbatim").
const CAUSES = [
  "Material em falta",
  "Erro de orçamento",
  "Acesso / condições no local",
  "Falha de equipamento",
  "Erro de instalação",
  "Alteração pedida pelo cliente",
  "Sinal / infraestrutura externa",
];

const DEFAULT_OUTLETS = ["Sala", "Quarto 1", "Quarto 2"];

const PHOTO_PHASES: { id: "before" | "during" | "after"; label: string }[] = [
  { id: "before", label: "Antes" },
  { id: "during", label: "Durante" },
  { id: "after", label: "Depois" },
];

type Stage = "ready" | "exec" | "aar";

type DispatchBlocking =
  | { kind: "checklist_item"; item_id: string; label: string }
  | { kind: "van_audit_stale"; van_label: string | null; next_due_at: string | null }
  | { kind: "calibration_expired"; equipment_id: string; kind_label: string; expired_on: string | null }
  | { kind: "ited_classification_unreviewed"; job_id: string; ited_classification: string };

const eur = (n: string | number) => `€${Number(n).toFixed(2)}`;

const CAT_META: Record<
  ChecklistItem["cat"],
  { label: string; icon: typeof Package; color: string }
> = {
  material: { label: "Material", icon: Package, color: "text-cyan-600" },
  equipment: { label: "Equipamento", icon: Wrench, color: "text-zinc-500" },
  doc: { label: "Documentação", icon: FileText, color: "text-amber-600" },
};

const SCOPE_SECTIONS: {
  scope: ChecklistItem["scope"];
  title: string;
  desc: string;
}[] = [
  {
    scope: "job",
    title: "Lista do técnico",
    desc: "É só isto que aparece no telemóvel.",
  },
  {
    scope: "van",
    title: "Stock da carrinha",
    desc: "Coberto pela auditoria semanal da carrinha.",
  },
  {
    scope: "office",
    title: "Verificado pelo escritório",
    desc: "Automático. O técnico nunca vê estes itens.",
  },
];

function blockingText(b: DispatchBlocking): string {
  switch (b.kind) {
    case "checklist_item":
      return `Item obrigatório em falta: ${b.label}`;
    case "van_audit_stale":
      return b.van_label
        ? `Auditoria da carrinha "${b.van_label}" caducada${
            b.next_due_at ? ` (venceu em ${new Date(b.next_due_at).toLocaleDateString("pt-PT")})` : ""
          }`
        : "Sem auditoria de carrinha válida registada";
    case "calibration_expired":
      return `Calibração expirada: ${b.kind_label}${
        b.expired_on ? ` (venceu em ${new Date(b.expired_on).toLocaleDateString("pt-PT")})` : " (sem data de calibração)"
      }`;
    case "ited_classification_unreviewed":
      return `Classificação ITED por rever no escritório (atual: ${b.ited_classification})`;
  }
}

export function JobDetail({
  job,
  clientName,
  initialReadiness,
}: {
  job: Job;
  clientName: string | null;
  initialReadiness: Readiness;
}) {
  const [stage, setStage] = useState<Stage>("ready");
  const [status, setStatus] = useState(job.status);
  const [items, setItems] = useState<ChecklistItem[]>(initialReadiness.items);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<DispatchBlocking[] | null>(null);
  const [dispatchOk, setDispatchOk] = useState(false);

  const { label: statusLabel, tone: statusTone } = jobStatusLabel(status);

  const mandatory = items.filter((c) => c.mandatory);
  const mandatoryOk = mandatory.filter((c) => c.status === "ok").length;
  const cleared = mandatory.length > 0 ? mandatoryOk === mandatory.length : mandatoryOk === 0;
  const pctValue = mandatory.length > 0 ? Math.round((mandatoryOk / mandatory.length) * 100) : 100;
  const missingMandatoryCount = mandatory.length - mandatoryOk;

  const canDispatch = status === "ready_check";

  async function toggleItem(item: ChecklistItem) {
    if (togglingId) return;
    const nextStatus = item.status === "ok" ? "missing" : "ok";
    setTogglingId(item.id);
    setDispatchOk(false);
    try {
      await apiFetch(`/jobs/${job.id}/checklist/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setItems((prev) =>
        prev.map((c) => (c.id === item.id ? { ...c, status: nextStatus } : c))
      );
    } catch {
      setDispatchError("Não foi possível atualizar este item. Tente novamente.");
    } finally {
      setTogglingId(null);
    }
  }

  async function dispatch() {
    setDispatching(true);
    setDispatchError(null);
    setBlocking(null);
    setDispatchOk(false);
    try {
      await apiFetch(`/jobs/${job.id}/dispatch`, { method: "POST" });
      setStatus("dispatched");
      setDispatchOk(true);
      setStage("exec");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as
          | { error: "not_ready"; blocking: DispatchBlocking[] }
          | { error: "wrong_status"; status: string };
        if (body.error === "not_ready") {
          setBlocking(body.blocking);
        } else {
          setDispatchError(
            `Este trabalho já avançou para o estado "${jobStatusLabel(body.status).label}" — não pode ser despachado novamente.`
          );
          setStatus(body.status);
        }
      } else {
        setDispatchError("Não foi possível despachar o trabalho. Tente novamente.");
      }
    } finally {
      setDispatching(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded border border-zinc-200 p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <Pill tone={statusTone}>{statusLabel}</Pill>
            </div>
            <div className="text-sm font-medium mt-1.5 text-zinc-900">
              {clientName || "Cliente desconhecido"}
            </div>
            <div className="text-xs text-zinc-500 mt-0.5">
              {job.address && <>{job.address} · </>}
              {job.job_type}
            </div>
            <div className="text-xs text-zinc-500 font-mono tabular-nums">
              {job.scheduled_at
                ? new Date(job.scheduled_at).toLocaleString("pt-PT")
                : "Sem data agendada"}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-zinc-500">Orçamentado</div>
            <div className="text-sm font-mono tabular-nums font-medium">
              {Number(job.quoted_hours).toFixed(1)} h · {eur(job.quoted_materials)}
            </div>
          </div>
        </div>

        <div className="mt-4 flex gap-1 border-b border-zinc-200">
          {(
            [
              ["ready", "1 · Readiness"],
              ["exec", "2 · Execução"],
              ["aar", "3 · After-action report"],
            ] as [Stage, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setStage(id)}
              className={`px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors ${
                stage === id
                  ? "border-cyan-600 text-cyan-700 font-medium"
                  : "border-transparent text-zinc-500 hover:text-zinc-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {stage === "ready" && (
        <ReadinessTab
          jobId={job.id}
          items={items}
          cleared={cleared}
          pctValue={pctValue}
          missingMandatoryCount={missingMandatoryCount}
          canDispatch={canDispatch}
          togglingId={togglingId}
          onToggle={toggleItem}
          dispatching={dispatching}
          dispatchError={dispatchError}
          blocking={blocking}
          dispatchOk={dispatchOk}
          onDispatch={dispatch}
        />
      )}

      {stage === "exec" && (
        <ExecutionTab jobId={job.id} executionSnapshot={job.execution_snapshot} />
      )}
      {stage === "aar" && (
        <AARTab
          jobId={job.id}
          testProtocolSnapshot={job.test_protocol_snapshot}
          completedAt={job.completed_at}
          status={status}
          onStatusChange={setStatus}
        />
      )}
    </div>
  );
}

// Shared card/section chrome, matching ReadinessTab's scope-section markup
// (px-4 py-3 border-b header + p-4 body) so all three tabs read as one
// visual system.
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

function ErrorNote({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}

function SuccessNote({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
      <span>{text}</span>
    </div>
  );
}

function ReadinessTab({
  jobId,
  items,
  cleared,
  pctValue,
  missingMandatoryCount,
  canDispatch,
  togglingId,
  onToggle,
  dispatching,
  dispatchError,
  blocking,
  dispatchOk,
  onDispatch,
}: {
  jobId: string;
  items: ChecklistItem[];
  cleared: boolean;
  pctValue: number;
  missingMandatoryCount: number;
  canDispatch: boolean;
  togglingId: string | null;
  onToggle: (item: ChecklistItem) => void;
  dispatching: boolean;
  dispatchError: string | null;
  blocking: DispatchBlocking[] | null;
  dispatchOk: boolean;
  onDispatch: () => void;
}) {
  return (
    <>
      <div
        className={`rounded border p-4 ${
          cleared ? "bg-green-50 border-green-300" : "bg-amber-50 border-amber-300"
        }`}
      >
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {cleared ? (
              <CheckCircle2 className="w-6 h-6 text-green-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0" />
            )}
            <div>
              <div className="text-sm font-semibold text-zinc-900">
                {cleared
                  ? "Pronto para despacho"
                  : `Despacho bloqueado — ${missingMandatoryCount} ${
                      missingMandatoryCount === 1 ? "item obrigatório em falta" : "itens obrigatórios em falta"
                    }`}
              </div>
              <div className="text-xs text-zinc-600 font-mono tabular-nums">
                {items.filter((c) => c.mandatory && c.status === "ok").length} de{" "}
                {items.filter((c) => c.mandatory).length} verificações obrigatórias · {pctValue}%
              </div>
            </div>
          </div>

          {canDispatch ? (
            <button
              disabled={!cleared || dispatching}
              onClick={onDispatch}
              className={`flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium transition-colors ${
                cleared && !dispatching
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "bg-zinc-200 text-zinc-400 cursor-not-allowed"
              }`}
            >
              {dispatching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {dispatching ? "A despachar…" : "Despachar trabalho"}
            </button>
          ) : (
            <Pill tone="zinc">Fase de despacho concluída</Pill>
          )}
        </div>
      </div>

      {dispatchOk && (
        <div className="flex items-start gap-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>Trabalho despachado — segue para a fase de Execução.</span>
        </div>
      )}

      {dispatchError && (
        <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{dispatchError}</span>
        </div>
      )}

      {blocking && blocking.length > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-3">
          <div className="text-sm font-medium text-red-800 flex items-center gap-1.5">
            <AlertTriangle className="w-4 h-4" />
            O servidor recusou o despacho — {blocking.length}{" "}
            {blocking.length === 1 ? "motivo" : "motivos"}
          </div>
          <ul className="mt-2 space-y-1">
            {blocking.map((b, i) => (
              <li key={i} className="text-xs text-red-700 flex items-start gap-1.5">
                <span className="mt-1 w-1 h-1 rounded-full bg-red-500 shrink-0" />
                <span>{blockingText(b)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {SCOPE_SECTIONS.map(({ scope, title, desc }) => {
        const rows = items.filter((c) => c.scope === scope);
        if (rows.length === 0) return null;
        const done = rows.filter((c) => c.status === "ok").length;
        const readOnly = scope === "office";

        return (
          <div key={scope} className="bg-white rounded border border-zinc-200">
            <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
                <p className="text-xs text-zinc-500 mt-0.5">{desc}</p>
              </div>
              <Pill tone={done === rows.length ? "green" : "amber"}>
                {done}/{rows.length}
              </Pill>
            </div>
            <div className="p-4 space-y-1.5">
              {rows.map((c) => {
                const CatIcon = CAT_META[c.cat].icon;
                const isOk = c.status === "ok";
                const busy = togglingId === c.id;

                return (
                  <div
                    key={c.id}
                    className={`flex items-center gap-3 p-2 rounded border ${
                      isOk ? "border-zinc-100" : "border-red-200 bg-red-50"
                    }`}
                  >
                    {readOnly ? (
                      <span
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                          isOk ? "bg-green-600 border-green-600" : "border-zinc-300 bg-white"
                        }`}
                        aria-hidden
                      >
                        {isOk && <CheckCircle2 className="w-3.5 h-3.5 text-white" />}
                      </span>
                    ) : (
                      <button
                        onClick={() => onToggle(c)}
                        disabled={busy}
                        aria-label={isOk ? "Marcar como em falta" : "Marcar como verificado"}
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors disabled:opacity-50 ${
                          isOk ? "bg-green-600 border-green-600" : "border-zinc-300 bg-white hover:border-zinc-400"
                        }`}
                      >
                        {busy ? (
                          <Loader2 className="w-3 h-3 text-zinc-500 animate-spin" />
                        ) : (
                          isOk && <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        )}
                      </button>
                    )}
                    <CatIcon className={`w-4 h-4 shrink-0 ${CAT_META[c.cat].color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm flex items-center gap-2 flex-wrap">
                        <span className={isOk ? "text-zinc-700" : "font-medium text-zinc-900"}>
                          {c.label}
                        </span>
                        {!c.mandatory && <Pill>opcional</Pill>}
                        <StatusPill ok={isOk} />
                      </div>
                    </div>
                    <div className="text-xs text-zinc-500 font-mono tabular-nums shrink-0">
                      ×{c.qty}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

// Colorblind-safe pass/fail: icon + word + color together, never color
// alone (CLAUDE.md/PRD §6) — applied per checklist item, not just on the
// top-level readiness banner.
function StatusPill({ ok }: { ok: boolean }) {
  const tone: PillTone = ok ? "green" : "red";
  return (
    <Pill tone={tone}>
      {ok ? (
        <>
          <CheckCircle2 className="w-3 h-3" /> OK
        </>
      ) : (
        <>
          <AlertTriangle className="w-3 h-3" /> Em falta
        </>
      )}
    </Pill>
  );
}

/* --------------------------- EXECUÇÃO --------------------------- */

function ExecutionTab({
  jobId,
  executionSnapshot,
}: {
  jobId: string;
  executionSnapshot: ExecutionSnapshot;
}) {
  const steps = executionSnapshot?.steps ?? [];
  const [completed, setCompleted] = useState<Set<number>>(new Set());
  const [pendingOrder, setPendingOrder] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(order: number) {
    if (pendingOrder !== null) return;
    setPendingOrder(order);
    setError(null);
    try {
      await apiFetch(`/jobs/${jobId}/execution-steps/${order}/complete`, { method: "POST" });
      setCompleted((prev) => new Set(prev).add(order));
    } catch {
      setError("Não foi possível marcar este passo. Tente novamente.");
    } finally {
      setPendingOrder(null);
    }
  }

  return (
    <>
      {steps.length === 0 ? (
        <div className="bg-white rounded border border-zinc-200 p-6 text-center text-sm text-zinc-500">
          Sem passos de execução definidos para este tipo de trabalho.
        </div>
      ) : (
        <Section title="Passos de execução" desc={`${completed.size} de ${steps.length} concluídos`}>
          <div className="space-y-1.5">
            {steps.map((s) => {
              const done = completed.has(s.order);
              const busy = pendingOrder === s.order;
              return (
                <button
                  key={s.order}
                  onClick={() => toggle(s.order)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 p-2 rounded hover:bg-zinc-50 text-left disabled:opacity-60"
                >
                  <span
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                      done ? "bg-cyan-600 border-cyan-600" : "border-zinc-300"
                    }`}
                  >
                    {busy ? (
                      <Loader2 className="w-3 h-3 text-zinc-500 animate-spin" />
                    ) : (
                      done && <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                    )}
                  </span>
                  <span className={`text-sm ${done ? "text-zinc-400 line-through" : "text-zinc-800"}`}>
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      )}

      {error && <ErrorNote text={error} />}

      <PhotoUploadSection jobId={jobId} />
    </>
  );
}

function PhotoUploadSection({ jobId }: { jobId: string }) {
  const [uploaded, setUploaded] = useState<Record<string, string>>({});
  const [uploadingPhase, setUploadingPhase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(phase: "before" | "during" | "after", file: File | null) {
    if (!file) return;
    setUploadingPhase(phase);
    setError(null);
    try {
      await uploadPhoto(jobId, file, phase);
      setUploaded((prev) => ({ ...prev, [phase]: file.name }));
    } catch {
      setError("Não foi possível enviar a fotografia. Tente novamente.");
    } finally {
      setUploadingPhase(null);
    }
  }

  return (
    <Section title="Registo fotográfico" desc="Antes / durante / depois — obrigatório para fecho">
      <div className="grid grid-cols-3 gap-2">
        {PHOTO_PHASES.map(({ id, label }) => {
          const fileName = uploaded[id];
          const busy = uploadingPhase === id;
          return (
            <label
              key={id}
              className={`block border-2 border-dashed rounded p-4 text-center cursor-pointer transition-colors ${
                fileName ? "border-green-300 bg-green-50" : "border-zinc-300 hover:border-cyan-400"
              } ${busy ? "opacity-60 cursor-wait" : ""}`}
            >
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  handleFile(id, e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
              {busy ? (
                <Loader2 className="w-5 h-5 text-cyan-600 mx-auto animate-spin" />
              ) : fileName ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 mx-auto" />
              ) : (
                <Camera className="w-5 h-5 text-zinc-400 mx-auto" />
              )}
              <div className="text-xs text-zinc-500 mt-1">{label}</div>
              {fileName && <div className="text-[11px] text-green-700 mt-0.5 truncate">{fileName}</div>}
            </label>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </Section>
  );
}

/* --------------------------- AFTER-ACTION REPORT --------------------------- */

type TestOutcome = "pass" | "fail" | "pending" | "na";

function threshLabel(t: TestProtocolTest): string {
  if (t.dir === "range") return `${t.min}–${t.max} ${t.unit}`;
  if (t.dir === "min") return `≥ ${t.min} ${t.unit}`;
  if (t.dir === "external_pass_fail") return "Pass/Fail (EN 50173 Classe E)";
  return `≤ ${t.max} ${t.unit}`;
}

function cellKey(outlet: string, testId: string): string {
  return `${outlet}::${testId}`;
}

function AARTab({
  jobId,
  testProtocolSnapshot,
  completedAt,
  status,
  onStatusChange,
}: {
  jobId: string;
  testProtocolSnapshot: TestProtocolSnapshot;
  completedAt: string | null;
  status: string;
  onStatusChange: (status: string) => void;
}) {
  const [cells, setCells] = useState<
    Record<string, { value: string; outcome: TestOutcome | null; saving: boolean }>
  >({});

  const [completed, setCompleted] = useState(completedAt !== null || status === "closed");
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const [closeoutSubmitted, setCloseoutSubmitted] = useState(status === "closed");
  const [firstTimeFix, setFirstTimeFix] = useState<"yes" | "no" | null>(null);
  const [noteTranscript, setNoteTranscript] = useState("");
  const [submittingCloseout, setSubmittingCloseout] = useState(false);
  const [closeoutError, setCloseoutError] = useState<string | null>(null);

  const [reworkCause, setReworkCause] = useState(CAUSES[0]);
  const [savingCause, setSavingCause] = useState(false);
  const [causeSaved, setCauseSaved] = useState(false);
  const [causeError, setCauseError] = useState<string | null>(null);

  async function submitTestResult(outlet: string, test: TestProtocolTest, value: string) {
    const key = cellKey(outlet, test.id);
    setCells((prev) => ({ ...prev, [key]: { value, outcome: prev[key]?.outcome ?? null, saving: true } }));
    try {
      const row = await apiFetch<{ outcome: TestOutcome }>(`/jobs/${jobId}/test-results`, {
        method: "POST",
        body: JSON.stringify({
          network_type: testProtocolSnapshot!.network_type,
          location_label: outlet,
          test_code: test.id,
          measured_value: value,
          capture_source: "manual",
        }),
      });
      setCells((prev) => ({ ...prev, [key]: { value, outcome: row.outcome, saving: false } }));
    } catch {
      setCells((prev) => ({ ...prev, [key]: { value, outcome: prev[key]?.outcome ?? null, saving: false } }));
    }
  }

  async function complete() {
    setCompleting(true);
    setCompleteError(null);
    try {
      const row = await apiFetch<{ status: string }>(`/jobs/${jobId}/complete`, { method: "POST" });
      setCompleted(true);
      onStatusChange(row.status);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setCompleteError("Este trabalho já foi concluído, ou não está num estado que permita concluir.");
      } else {
        setCompleteError("Não foi possível concluir o trabalho. Tente novamente.");
      }
    } finally {
      setCompleting(false);
    }
  }

  async function submitCloseoutForm() {
    if (firstTimeFix === null || noteTranscript.trim() === "") return;
    setSubmittingCloseout(true);
    setCloseoutError(null);
    try {
      await apiFetch(`/jobs/${jobId}/closeout`, {
        method: "POST",
        body: JSON.stringify({
          first_time_fix: firstTimeFix === "yes",
          technician_note_transcript: noteTranscript.trim(),
        }),
      });
      setCloseoutSubmitted(true);
      onStatusChange("closed");
    } catch {
      setCloseoutError("Não foi possível submeter o fecho do trabalho. Tente novamente.");
    } finally {
      setSubmittingCloseout(false);
    }
  }

  async function saveReworkCause() {
    setSavingCause(true);
    setCauseError(null);
    setCauseSaved(false);
    try {
      await apiFetch(`/jobs/${jobId}/closeout/rework-cause`, {
        method: "PATCH",
        body: JSON.stringify({ rework_cause: reworkCause }),
      });
      setCauseSaved(true);
    } catch {
      setCauseError("Não foi possível guardar a causa-raiz. Tente novamente.");
    } finally {
      setSavingCause(false);
    }
  }

  return (
    <>
      {testProtocolSnapshot ? (
        <Section
          title="Testes de aceitação"
          desc={`Rede ${testProtocolSnapshot.network_type} · medido em cada tomada · pass/fail automático contra o limiar`}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-zinc-500 border-b border-zinc-200">
                  <th className="py-1.5 pr-2">Tomada</th>
                  {testProtocolSnapshot.tests.map((t) => (
                    <th key={t.id} className="pr-2 font-normal">
                      <div className="font-medium text-zinc-700">{t.label}</div>
                      <div className="text-zinc-400 font-mono tabular-nums">{threshLabel(t)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DEFAULT_OUTLETS.map((outlet) => (
                  <tr key={outlet} className="border-b border-zinc-100">
                    <td className="py-2 pr-2 font-medium text-zinc-800 align-top">{outlet}</td>
                    {testProtocolSnapshot.tests.map((t) => {
                      const key = cellKey(outlet, t.id);
                      const cell = cells[key];
                      return (
                        <td key={t.id} className="pr-2 py-1.5 align-top">
                          {t.dir === "external_pass_fail" ? (
                            // No numeric threshold exists for this test (the
                            // certifying instrument's own verdict IS the
                            // measured value, ited-ref-mapping.md §7A.3) — a
                            // number input would reject "pass"/"fail"
                            // outright, so this renders as a two-button
                            // toggle instead, matching the pass/fail
                            // icon+word+color convention used elsewhere
                            // rather than a free-text field.
                            <div className="flex gap-1">
                              {(["pass", "fail"] as const).map((v) => (
                                <button
                                  key={v}
                                  type="button"
                                  disabled={cell?.saving}
                                  onClick={() => submitTestResult(outlet, t, v)}
                                  className={`px-2 py-1 rounded border text-xs font-medium ${
                                    cell?.outcome === v
                                      ? v === "pass"
                                        ? "border-green-400 bg-green-50 text-green-800"
                                        : "border-red-400 bg-red-50 text-red-800"
                                      : "border-zinc-300 text-zinc-500"
                                  }`}
                                >
                                  {v === "pass" ? "Pass" : "Fail"}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <input
                              type="number"
                              step="any"
                              inputMode="decimal"
                              defaultValue={cell?.value ?? ""}
                              disabled={cell?.saving}
                              onBlur={(e) => {
                                const v = e.target.value.trim();
                                if (v === "") return;
                                submitTestResult(outlet, t, v);
                              }}
                              className={`w-20 px-1.5 py-1 rounded border font-mono tabular-nums text-xs ${
                                cell?.outcome === "fail"
                                  ? "border-red-400 bg-red-50 text-red-800 font-medium"
                                  : cell?.outcome === "pass"
                                    ? "border-green-300 bg-green-50 text-green-800"
                                    : "border-zinc-300"
                              }`}
                            />
                          )}
                          <div className="mt-1">
                            {cell?.saving ? (
                              <span className="text-zinc-400 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" /> a guardar…
                              </span>
                            ) : cell?.outcome ? (
                              <OutcomePill outcome={cell.outcome} />
                            ) : null}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-400 mt-2">
            Limiares são os do protocolo de teste resolvido para este trabalho no momento do despacho
            (arquitetura §5 — nunca re-lido do template depois disso).
          </p>
        </Section>
      ) : (
        <div className="bg-white rounded border border-zinc-200 p-6 text-center text-sm text-zinc-500">
          Sem protocolo de teste aplicável.
        </div>
      )}

      {!completed && (
        <div className="bg-white rounded border border-zinc-200 p-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="text-sm font-medium text-zinc-900">Concluir trabalho</div>
            <div className="text-xs text-zinc-500 mt-0.5">
              Marca a execução como terminada e liberta o formulário de fecho abaixo.
            </div>
          </div>
          <button
            onClick={complete}
            disabled={completing}
            className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {completing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {completing ? "A concluir…" : "Concluir trabalho"}
          </button>
        </div>
      )}
      {completeError && <ErrorNote text={completeError} />}

      {completed && !closeoutSubmitted && (
        <Section title="Fecho do trabalho (F19)" desc="Resolvido à primeira visita + observações do técnico">
          <div className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500">Resolvido à primeira visita?</label>
              <div className="flex gap-2 mt-1">
                {(
                  [
                    ["yes", "Sim"],
                    ["no", "Não — requer retorno"],
                  ] as [string, string][]
                ).map(([v, l]) => (
                  <button
                    key={v}
                    onClick={() => setFirstTimeFix(v as "yes" | "no")}
                    className={`px-3 py-1.5 rounded text-xs border ${
                      firstTimeFix === v
                        ? "bg-zinc-900 text-white border-zinc-900"
                        : "border-zinc-300 text-zinc-600 hover:border-zinc-400"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-zinc-500">Observações</label>
              <textarea
                value={noteTranscript}
                onChange={(e) => setNoteTranscript(e.target.value)}
                rows={4}
                className="w-full mt-1 px-2 py-1.5 border border-zinc-300 rounded text-xs"
                placeholder="O que aconteceu, em palavras próprias…"
              />
            </div>
            <div className="flex justify-end">
              <button
                onClick={submitCloseoutForm}
                disabled={submittingCloseout || firstTimeFix === null || noteTranscript.trim() === ""}
                className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submittingCloseout && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {submittingCloseout ? "A submeter…" : "Submeter fecho"}
              </button>
            </div>
          </div>
        </Section>
      )}
      {closeoutError && <ErrorNote text={closeoutError} />}

      {closeoutSubmitted && (
        <>
          <SuccessNote text="Fecho do trabalho submetido — trabalho concluído." />

          {/* Office-only rework-cause control — visually distinct (dark
              header strip, not a form field among the technician's own) so
              it reads unambiguously as a different actor's input. Never
              appears on any technician-facing screen (PRD §6 / CLAUDE.md). */}
          <div className="rounded border-2 border-zinc-900 bg-white overflow-hidden">
            <div className="bg-zinc-900 text-white text-xs font-mono uppercase tracking-wider px-4 py-1.5">
              Escritório · não visível ao técnico
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="text-xs text-zinc-500">Causa-raiz (taxonomia fixa)</label>
                <select
                  value={reworkCause}
                  onChange={(e) => {
                    setReworkCause(e.target.value);
                    setCauseSaved(false);
                  }}
                  className="w-full mt-1 px-2 py-1.5 border border-zinc-300 rounded text-sm bg-white"
                >
                  {CAUSES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={saveReworkCause}
                  disabled={savingCause}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {savingCause && <Loader2 className="w-3 h-3 animate-spin" />}
                  {savingCause ? "A guardar…" : "Guardar causa-raiz"}
                </button>
                {causeSaved && <Pill tone="green">Guardado</Pill>}
              </div>
              {causeError && <p className="text-xs text-red-600">{causeError}</p>}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// Colorblind-safe test outcome: icon + word + color together (CLAUDE.md/PRD §6).
function OutcomePill({ outcome }: { outcome: TestOutcome }) {
  switch (outcome) {
    case "pass":
      return (
        <Pill tone="green">
          <CheckCircle2 className="w-3 h-3" /> Conforme
        </Pill>
      );
    case "fail":
      return (
        <Pill tone="red">
          <AlertTriangle className="w-3 h-3" /> Não conforme
        </Pill>
      );
    case "pending":
      return (
        <Pill tone="amber">
          <Clock className="w-3 h-3" /> Pendente
        </Pill>
      );
    case "na":
      return (
        <Pill tone="zinc">
          <MinusCircle className="w-3 h-3" /> N/A
        </Pill>
      );
  }
}
