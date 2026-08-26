"use client";

/*
 * Readiness walkthrough — ports fieldready-prototype.jsx's "prep" screen
 * exactly: one checklist item per screen, big tinted category icon, huge
 * font-mono quantity, two BigBtn tap targets ("Tenho" / "Não tenho").
 * CLAUDE.md: "treat its interaction design as settled."
 *
 * Technician-auth migration (08-supabase-native-migration.md §2): reads
 * are now a direct `.from("job_checklist_item")` query (scope="job"
 * filtered server-side) instead of GET /api/jobs/:id/readiness, mirroring
 * the exact column set office/jobs/[id]/page.tsx's own already-proven
 * query already selects. Units for material items come from a second
 * `.from("catalog_item")` lookup (item_id -> unit); items with no item_id
 * (doc rows) show "documento", matching the prototype's
 * `c.itemId ? itemById(c.itemId).unit : "documento"` fallback.
 *
 * Cycling stays client-side state (a single index over one fetched list),
 * exactly like the prototype's `screens.prep` — NOT one route per item,
 * per this stage's explicit instruction. To hand the "Tenho"/"Não tenho"
 * answers across the real route boundary to /prep-result, they're written
 * to sessionStorage keyed by job id right before navigating; prep-result
 * reads that back. This is local-only, not a durable/synced answer.
 *
 * Each tap ALSO enqueues a checklist_item.update mutation
 * (src/lib/offline-queue.ts) so the answer survives offline and reaches
 * the office via the real sync loop (components/field/OutboxSync.tsx).
 * enqueueMutation() writes to IndexedDB and returns immediately — it is
 * never awaited before advancing the screen, so the tap stays instant
 * regardless of connectivity.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronLeft, CheckCircle2, XCircle, Package, Wrench, FileText } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { enqueueMutation } from "@/lib/offline-queue";
import { BigButton } from "@/components/field/BigButton";
import { prepStorageKey, type Cat, type ReadinessItem, type PrepAnswerItem } from "../_lib/prep";

const CAT_META: Record<Cat, { icon: typeof Package; tint: string }> = {
  material: { icon: Package, tint: "bg-cyan-100 text-cyan-700" },
  equipment: { icon: Wrench, tint: "bg-zinc-200 text-zinc-600" },
  doc: { icon: FileText, tint: "bg-amber-100 text-amber-700" },
};

function formatQty(qty: string | number): string {
  const n = Number(qty);
  if (!Number.isFinite(n)) return String(qty);
  return Number.isInteger(n) ? String(n) : String(n);
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; list: ReadinessItem[]; units: Map<string, string> };

export default function PrepPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, "yes" | "no">>({});

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const supabase = createSupabaseBrowserClient();
        const [{ data: items, error: itemsError }, { data: catalogItems, error: catalogError }] =
          await Promise.all([
            supabase
              .from("job_checklist_item")
              .select("id, cat, label, qty, item_id, scope, mandatory, status")
              .eq("job_id", jobId)
              .eq("scope", "job")
              .order("cat")
              .order("label"),
            supabase.from("catalog_item").select("id, unit"),
          ]);
        if (cancelled) return;
        if (itemsError) throw itemsError;
        if (catalogError) throw catalogError;

        const units = new Map((catalogItems ?? []).map((c) => [c.id, c.unit]));
        setState({ kind: "ready", list: (items ?? []) as ReadinessItem[], units });
        setIdx(0);
        setAnswers({});
      } catch {
        if (cancelled) return;
        setState({ kind: "error", message: "Não foi possível carregar a lista de verificação." });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [jobId, router]);

  function goBack() {
    if (idx > 0) {
      setIdx(idx - 1);
    } else {
      router.push("/field/home");
    }
  }

  function answer(item: ReadinessItem, value: "yes" | "no", list: ReadinessItem[]) {
    // Fire-and-forget: enqueueMutation() is synchronous/local (IndexedDB
    // write only, no network call), so this never blocks the tap — see
    // file header and offline-queue.ts's own doc comment on that contract.
    void enqueueMutation({
      type: "checklist_item.update",
      job_id: jobId,
      payload: { item_id: item.id, status: value === "yes" ? "ok" : "missing" },
    });

    const nextAnswers = { ...answers, [item.id]: value };
    if (idx + 1 < list.length) {
      setAnswers(nextAnswers);
      setIdx(idx + 1);
      return;
    }

    // Last item: hand the recorded answers to /prep-result across the real
    // route boundary via sessionStorage — see file header.
    const payload: PrepAnswerItem[] = list.map((c) => ({
      ...c,
      answer: nextAnswers[c.id] ?? null,
    }));
    try {
      sessionStorage.setItem(prepStorageKey(jobId), JSON.stringify(payload));
    } catch {
      // sessionStorage unavailable (private browsing etc.) — prep-result
      // handles a missing/unreadable key by sending the technician back
      // here rather than crashing.
    }
    router.push(`/field/jobs/${jobId}/prep-result`);
  }

  if (state.kind === "loading") {
    return <div className="h-full bg-white" />;
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col h-full bg-white p-6 items-center justify-center text-center gap-3">
        <XCircle className="w-8 h-8 text-red-500" />
        <p className="text-sm text-zinc-600">{state.message}</p>
        <BigButton tone="ghost" onClick={() => router.push("/field/home")}>
          Voltar ao início
        </BigButton>
      </div>
    );
  }

  const { list, units } = state;

  if (list.length === 0) {
    return (
      <div className="flex flex-col h-full bg-white p-6 items-center justify-center text-center gap-3">
        <CheckCircle2 className="w-10 h-10 text-green-600" />
        <p className="text-base font-medium text-zinc-700">Nada para verificar neste trabalho.</p>
        <BigButton
          onClick={() => {
            try {
              sessionStorage.setItem(prepStorageKey(jobId), JSON.stringify([]));
            } catch {
              // see note above
            }
            router.push(`/field/jobs/${jobId}/prep-result`);
          }}
        >
          Continuar
        </BigButton>
      </div>
    );
  }

  const c = list[idx];
  const CatIcon = CAT_META[c.cat].icon;
  const unit = c.item_id ? units.get(c.item_id) ?? "un" : "documento";

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="px-4 pt-4 shrink-0">
        <div className="flex items-center justify-between">
          <button
            onClick={goBack}
            aria-label="Voltar"
            className="p-2 -ml-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
          >
            <ChevronLeft className="w-6 h-6 text-zinc-500" />
          </button>
          <div className="text-lg font-bold text-zinc-700 font-mono tabular-nums">
            {idx + 1} de {list.length}
          </div>
        </div>
        <div className="mt-2 h-2 bg-zinc-200 rounded-full overflow-hidden">
          <div
            className="h-full bg-cyan-600"
            style={{ width: `${(idx / list.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <div className={`w-40 h-40 rounded-2xl flex items-center justify-center ${CAT_META[c.cat].tint}`}>
          <CatIcon className="w-20 h-20" />
        </div>
        <div className="mt-6 text-2xl font-bold leading-tight">{c.label}</div>
        <div className="mt-3 text-5xl font-mono font-black tabular-nums text-zinc-900">
          {formatQty(c.qty)}
        </div>
        <div className="text-base text-zinc-500">{unit}</div>
      </div>

      <div className="p-4 space-y-3 shrink-0">
        <BigButton tone="green" icon={CheckCircle2} onClick={() => answer(c, "yes", list)}>
          Tenho
        </BigButton>
        <BigButton tone="red" icon={XCircle} onClick={() => answer(c, "no", list)}>
          Não tenho
        </BigButton>
      </div>
    </div>
  );
}
