"use client";

/*
 * Readiness walkthrough result — ports fieldready-prototype.jsx's
 * "prepresult" screen: full-bleed green "Pode arrancar" state when nothing
 * is missing, full-bleed red "Faltam N" state with the missing-items list
 * otherwise, "Cheguei ao local" -> /field/jobs/[id]/site either way.
 * CLAUDE.md: "treat its interaction design as settled."
 *
 * Reads the answers /prep recorded via sessionStorage (see
 * ../_lib/prep.ts — this stage doesn't persist answers to the API yet).
 * If nothing is there (direct navigation, cleared storage, private
 * browsing), send the technician back to /prep rather than render a
 * meaningless empty/green screen.
 *
 * The prototype's "Rota de recolha sugerida" supplier-pickup card is
 * deliberately omitted — there is no sourcing/supplier-price API yet
 * (Phase 4, project brief's build order), so faking supplier data isn't an
 * option. A short note marks it as deferred instead. Everything else
 * (missing-items list, the office-notified copy, "Cheguei ao local") is
 * kept faithful to the prototype.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { BigButton } from "@/components/field/BigButton";
import { prepStorageKey, type PrepAnswerItem } from "../_lib/prep";

type LoadState =
  | { kind: "loading" }
  | { kind: "missing-data" }
  | { kind: "ready"; missing: PrepAnswerItem[] };

export default function PrepResultPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(prepStorageKey(jobId));
    } catch {
      raw = null;
    }

    if (!raw) {
      setState({ kind: "missing-data" });
      return;
    }

    try {
      const items: PrepAnswerItem[] = JSON.parse(raw);
      setState({ kind: "ready", missing: items.filter((c) => c.answer === "no") });
    } catch {
      setState({ kind: "missing-data" });
    }
  }, [jobId]);

  useEffect(() => {
    if (state.kind === "missing-data") {
      router.replace(`/field/jobs/${jobId}/prep`);
    }
  }, [state.kind, jobId, router]);

  if (state.kind === "loading" || state.kind === "missing-data") {
    return <div className="h-full bg-white" />;
  }

  const { missing } = state;

  if (missing.length === 0) {
    return (
      <div className="flex flex-col h-full bg-green-600 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <CheckCircle2 className="w-20 h-20" />
          <div className="mt-4 text-3xl font-bold">Pode arrancar</div>
          <div className="mt-2 text-lg text-green-100">Tem tudo o que precisa</div>
        </div>
        <BigButton tone="ghost" onClick={() => router.push(`/field/jobs/${jobId}/site`)}>
          Cheguei ao local
        </BigButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-red-600 text-white">
      <div className="p-6 text-center shrink-0">
        <AlertTriangle className="w-16 h-16 mx-auto" />
        <div className="mt-3 text-2xl font-bold font-mono tabular-nums">Faltam {missing.length}</div>
      </div>
      <div className="flex-1 bg-white rounded-t-3xl p-4 overflow-auto">
        <div className="space-y-2">
          {missing.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border-2 border-red-200"
            >
              <XCircle className="w-6 h-6 text-red-600 shrink-0" />
              <span className="text-base font-medium text-zinc-900">
                {m.qty}× {m.label}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-4 p-3 rounded-xl bg-zinc-50 border-2 border-zinc-200 text-sm text-zinc-500">
          Sugestão de fornecedor mais próximo: disponível numa fase seguinte (comparação de
          preços/fornecedores ainda não implementada).
        </div>

        <div className="mt-4">
          <BigButton tone="ghost" onClick={() => router.push(`/field/jobs/${jobId}/site`)}>
            Cheguei ao local
          </BigButton>
        </div>
      </div>
    </div>
  );
}
