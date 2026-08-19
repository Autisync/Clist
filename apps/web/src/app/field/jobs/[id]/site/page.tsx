"use client";

/*
 * "No local" screen — ports fieldready-prototype.jsx's "site" screen
 * (fieldready-prototype.jsx:1557-1581): a checklist of execution steps,
 * each one tappable to mark complete, then "Fazer as medições" through to
 * /tests. CLAUDE.md: "treat its interaction design as settled."
 *
 * Real data: GET /api/jobs/:id for job.execution_snapshot (resolved once at
 * job-creation time — architecture §5's "resolved once, never re-read"
 * rule — shape {steps:[{order,label}]}, see 05-phase2-job-loop.md §7 /
 * apps/api/test/phase2-proof.mjs's execution_steps template body). There is
 * no GET endpoint anywhere for job_execution_step_completion rows
 * (confirmed against apps/api/src/routes/jobs.ts and domain/execution-steps.ts
 * — only the POST /jobs/:id/execution-steps/:step/complete write path
 * exists), so which steps are already done isn't knowable from the server
 * on page load; completion is tracked as client-side state for this
 * session, same as /prep's own answers. Each tap still enqueues the real
 * mutation (src/lib/offline-queue.ts) so the office gets it via sync
 * regardless of whether this tab is later closed.
 *
 * The prototype's "A contar 2h 14 de Xh previstas" running-timer card is
 * deliberately omitted — there is no server-side timer-start endpoint
 * anywhere in the API (confirmed against apps/api/src/routes/jobs.ts), so
 * showing a number here would be fabricated, not real data. This stage's
 * own instruction: omit rather than fabricate.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { enqueueMutation } from "@/lib/offline-queue";
import { BigButton } from "@/components/field/BigButton";
import { PhoneScreen } from "@/components/field/PhoneScreen";

type ExecutionStep = { order: number; label: string };
type Job = { id: string; execution_snapshot: { steps: ExecutionStep[] } | null };

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; steps: ExecutionStep[] };

export default function SitePage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [done, setDone] = useState<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const job = await apiFetch<Job>(`/jobs/${jobId}`);
        if (cancelled) return;

        const steps = job.execution_snapshot?.steps ?? [];
        setState({ kind: "ready", steps: [...steps].sort((a, b) => a.order - b.order) });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push("/field/login");
          return;
        }
        setState({ kind: "error", message: "Não foi possível carregar os passos do trabalho." });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [jobId, router]);

  function completeStep(step: ExecutionStep) {
    if (done.has(step.order)) return; // already marked this session — no re-tap effect

    // Synchronous/local (IndexedDB write only) — never blocks the tap, see
    // offline-queue.ts's own contract.
    void enqueueMutation({
      type: "execution_step.complete",
      job_id: jobId,
      payload: { step: step.order },
    });

    setDone((prev) => new Set(prev).add(step.order));
  }

  if (state.kind === "loading") {
    return <div className="h-full bg-white" />;
  }

  if (state.kind === "error") {
    return (
      <PhoneScreen title="No local" onBack={() => router.push("/field/home")}>
        <p className="text-sm text-zinc-600">{state.message}</p>
      </PhoneScreen>
    );
  }

  const { steps } = state;
  const allDone = steps.length === 0 || steps.every((s) => done.has(s.order));

  return (
    <PhoneScreen title="No local" onBack={() => router.push("/field/home")}>
      {steps.length === 0 ? (
        <p className="text-base text-zinc-500 text-center py-8">
          Sem passos de execução definidos para este trabalho.
        </p>
      ) : (
        <div className="space-y-2">
          {steps.map((s) => {
            const isDone = done.has(s.order);
            return (
              <button
                key={s.order}
                onClick={() => completeStep(s)}
                className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 text-left min-h-[56px] ${
                  isDone ? "border-zinc-300 bg-white" : "border-zinc-200 bg-zinc-50"
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                    isDone ? "bg-green-600" : "bg-zinc-200"
                  }`}
                >
                  {isDone ? (
                    <CheckCircle2 className="w-5 h-5 text-white" />
                  ) : (
                    <span className="text-sm font-bold text-zinc-600">{s.order + 1}</span>
                  )}
                </div>
                <span className={`text-base ${isDone ? "text-zinc-400 line-through" : "font-medium"}`}>
                  {s.label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-4">
        <BigButton
          tone={allDone ? "dark" : "ghost"}
          onClick={() => router.push(`/field/jobs/${jobId}/tests`)}
        >
          Fazer as medições
        </BigButton>
      </div>
    </PhoneScreen>
  );
}
