"use client";

/*
 * Per-outlet measurement screen — ports fieldready-prototype.jsx's "tests"
 * screen (fieldready-prototype.jsx:1583-1653): one outlet at a time, each
 * of its protocol's tests as a big number input, pass/fail computed live,
 * "Próxima tomada"/"Terminar medições" through to /voice. CLAUDE.md: "treat
 * its interaction design as settled."
 *
 * Real data: GET /api/jobs/:id for job.test_protocol_snapshot — the frozen
 * TestProtocolBody (architecture §5's "resolved once" rule: this never
 * re-reads the template, only the snapshot already on the job row). If a
 * job has no snapshot at all (no test_protocol resolved at creation time),
 * this stage's own instruction is to show a plain "Sem protocolo
 * aplicável" state with a way to skip straight to /voice, not to fabricate
 * a protocol.
 *
 * OUTLETS is a small fixed set (Sala / Quarto 1 / Quarto 2), matching the
 * prototype's own OUTLETS constant (fieldready-prototype.jsx:1329) — real
 * per-outlet enumeration isn't part of any resolved snapshot or API
 * response today, so this keeps the prototype's fixed list rather than
 * inventing a new "outlets" concept the schema doesn't have.
 *
 * Pass/fail is computed client-side via evalTest — imported from
 * @fieldready/core (packages/core/src/test-protocol-eval.ts), the exact
 * same evaluator recordTestResult (apps/api/src/domain/test-results.ts)
 * runs server-side against this same snapshot, so the two can't disagree
 * (that file's own doc comment: "ported ... so client ... and server ...
 * can't disagree, rather than reimplementing it twice").
 *
 * Photo capture (<input type=file capture="environment">) uploads directly
 * via multipart POST /api/jobs/:id/photos (src/lib/api.ts's uploadPhoto —
 * binary bytes never go through the JSON mutation queue, per this stage's
 * task and photo.ts's own doc comment) with phase="evidence" and a
 * required_tag identifying which outlet/test it's evidence for. There is
 * no OCR service wired into this build (CLAUDE.md: "the meters can't
 * export" / no OCR vendor has been evaluated — Phase 4's receipt-OCR
 * evaluation is the closest analog and it hasn't happened either), so the
 * photo is captured as supporting evidence only — the technician still
 * types the measured value by hand, and every submitted measurement's
 * capture_source is "manual", matching this stage's exact payload
 * instruction rather than claiming an OCR read that never happened.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, XCircle, Camera, Loader2 } from "lucide-react";
import type { TestProtocolBody } from "@fieldready/core";
import { evalTest } from "@fieldready/core";
import { apiFetch, ApiError, uploadPhoto } from "@/lib/api";
import { enqueueMutation } from "@/lib/offline-queue";
import { BigButton } from "@/components/field/BigButton";
import { PhoneScreen } from "@/components/field/PhoneScreen";

const OUTLETS = ["Sala", "Quarto 1", "Quarto 2"];

type Job = { id: string; test_protocol_snapshot: TestProtocolBody | null };

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "no-protocol" }
  | { kind: "ready"; protocol: TestProtocolBody };

function threshLabel(t: TestProtocolBody["tests"][number]): string {
  if (t.dir === "range") return `${t.min}–${t.max} ${t.unit}`;
  if (t.dir === "min") return `≥ ${t.min} ${t.unit}`;
  return `≤ ${t.max} ${t.unit}`;
}

export default function TestsPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [outletIdx, setOutletIdx] = useState(0);
  // vals[outlet][testId] -> typed value; captures[outlet][testId] -> photo
  // evidence's object-store key, once uploaded.
  const [vals, setVals] = useState<Record<string, Record<string, string>>>({});
  const [captures, setCaptures] = useState<Record<string, Record<string, string>>>({});
  const [uploading, setUploading] = useState<string | null>(null); // "outlet:testId" while in flight

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const job = await apiFetch<Job>(`/jobs/${jobId}`);
        if (cancelled) return;

        if (!job.test_protocol_snapshot) {
          setState({ kind: "no-protocol" });
          return;
        }
        setState({ kind: "ready", protocol: job.test_protocol_snapshot });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push("/field/login");
          return;
        }
        setState({ kind: "error", message: "Não foi possível carregar o protocolo de testes." });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [jobId, router]);

  if (state.kind === "loading") {
    return <div className="h-full bg-white" />;
  }

  if (state.kind === "error") {
    return (
      <PhoneScreen title="Medições" onBack={() => router.push(`/field/jobs/${jobId}/site`)}>
        <p className="text-sm text-zinc-600">{state.message}</p>
      </PhoneScreen>
    );
  }

  if (state.kind === "no-protocol") {
    return (
      <PhoneScreen title="Medições" onBack={() => router.push(`/field/jobs/${jobId}/site`)}>
        <div className="flex flex-col items-center text-center gap-3 py-10">
          <XCircle className="w-10 h-10 text-zinc-300" />
          <p className="text-base font-medium text-zinc-600">Sem protocolo aplicável</p>
          <p className="text-sm text-zinc-500">
            Este trabalho não tem um protocolo de testes associado.
          </p>
          <div className="w-full pt-4">
            <BigButton onClick={() => router.push(`/field/jobs/${jobId}/voice`)}>
              Continuar
            </BigButton>
          </div>
        </div>
      </PhoneScreen>
    );
  }

  const { protocol } = state;
  const outlet = OUTLETS[outletIdx];
  const outletVals = vals[outlet] ?? {};

  function setVal(testId: string, value: string) {
    setVals((prev) => ({ ...prev, [outlet]: { ...(prev[outlet] ?? {}), [testId]: value } }));
  }

  async function capturePhoto(testId: string, file: File) {
    const key = `${outlet}:${testId}`;
    setUploading(key);
    try {
      const result = await uploadPhoto(jobId, file, "evidence", key);
      setCaptures((prev) => ({ ...prev, [outlet]: { ...(prev[outlet] ?? {}), [testId]: result.file } }));
    } catch {
      // Upload failed (offline, etc.) — evidence photo is optional, so this
      // silently leaves the field un-captured rather than blocking the
      // technician; manual value entry still works either way.
    } finally {
      setUploading(null);
    }
  }

  function submitOutlet() {
    for (const t of protocol.tests) {
      const value = outletVals[t.id];
      if (value === undefined || value === "") continue;
      void enqueueMutation({
        type: "test_result.record",
        job_id: jobId,
        payload: {
          network_type: protocol.network_type,
          location_label: outlet,
          test_code: t.id,
          measured_value: value,
          unit: t.unit,
          limit_ref: t.limit_ref,
          capture_source: "manual",
          raw_capture_file: captures[outlet]?.[t.id],
        },
      });
    }

    if (outletIdx + 1 < OUTLETS.length) {
      setOutletIdx(outletIdx + 1);
    } else {
      router.push(`/field/jobs/${jobId}/voice`);
    }
  }

  const hasAnyValue = protocol.tests.some((t) => (outletVals[t.id] ?? "") !== "");

  return (
    <PhoneScreen
      title={`Tomada ${outletIdx + 1} de ${OUTLETS.length}`}
      onBack={() => router.push(`/field/jobs/${jobId}/site`)}
    >
      <div className="text-2xl font-bold">{outlet}</div>

      <div className="mt-4 space-y-3">
        {protocol.tests.map((t) => {
          const raw = outletVals[t.id] ?? "";
          const outcome = evalTest(t, raw);
          const uploadKey = `${outlet}:${t.id}`;
          const hasCapture = Boolean(captures[outlet]?.[t.id]);

          return (
            <div
              key={t.id}
              className={`p-3 rounded-xl border-2 ${
                outcome === "pass"
                  ? "border-green-300 bg-green-50"
                  : outcome === "fail"
                    ? "border-red-400 bg-red-50"
                    : "border-zinc-300"
              }`}
            >
              <div className="flex items-center gap-3">
                {outcome === "pass" ? (
                  <CheckCircle2 className="w-6 h-6 text-green-700 shrink-0" />
                ) : outcome === "fail" ? (
                  <XCircle className="w-6 h-6 text-red-700 shrink-0" />
                ) : (
                  <div className="w-6 h-6 rounded-full border-2 border-zinc-300 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-base font-medium leading-tight">{t.label}</div>
                  <div className="text-sm text-zinc-500">Deve ser {threshLabel(t)}</div>
                </div>
                <input
                  value={raw}
                  inputMode="decimal"
                  onChange={(e) => setVal(t.id, e.target.value)}
                  aria-label={`Valor medido — ${t.label}`}
                  className="w-24 px-2 py-2 text-lg font-mono font-bold tabular-nums text-right border-2 border-zinc-300 rounded"
                />
              </div>

              <div className="mt-2 flex items-center gap-2">
                <label
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold border-2 min-h-[44px] ${
                    hasCapture
                      ? "border-cyan-300 bg-cyan-50 text-cyan-800"
                      : "border-zinc-300 bg-white text-zinc-700 active:bg-zinc-100"
                  }`}
                >
                  {uploading === uploadKey ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4" />
                  )}
                  {uploading === uploadKey ? "A enviar…" : hasCapture ? "Foto guardada" : "Fotografar o medidor"}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void capturePhoto(t.id, file);
                    }}
                  />
                </label>
              </div>
              <p className="mt-1 text-xs text-zinc-500 text-center">
                A foto fica como evidência — o valor escreve-se sempre à mão.
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-4">
        <BigButton tone={hasAnyValue ? "dark" : "ghost"} onClick={submitOutlet}>
          {outletIdx + 1 < OUTLETS.length ? "Próxima tomada" : "Terminar medições"}
        </BigButton>
      </div>
    </PhoneScreen>
  );
}
