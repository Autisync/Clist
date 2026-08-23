"use client";

/*
 * Line-item editor (rpc_quote_lines_replace, full-replace — the whole
 * array is edited client-side then submitted as one call, per the build
 * task and the RPC's own semantics) + Aceitar (rpc_quote_accept) + Criar
 * trabalho (rpc_create_job_from_quote, redirects to the new job's detail
 * page). §6 Step 5: every write here goes straight to Supabase now — see
 * apps/api/supabase/rpc.sql's own comments on each function for why they
 * needed one (atomicity for the delete-then-reinsert and the status-guarded
 * accept transition, same TOCTOU reasoning job-detail's own RPCs already
 * established).
 *
 * No read path for existing lines exists yet either way (no
 * v_quote_lines view or equivalent), so this editor always starts from an
 * empty row set rather than pretending to load saved lines — the amber
 * note below says so plainly instead of silently looking like data loss.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus, Trash2, Save, ArrowRight } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Pill, quoteStatusLabel } from "../../../_components/pill";

type Quote = {
  id: string;
  client_id: string;
  job_type: string;
  quoted_hours: string;
  quoted_materials: string;
  status: string;
  accepted_at: string | null;
  created_at: string;
};

type CatalogItem = { id: string; sku: string; name: string; unit: string };

type LineDraft = {
  key: string;
  item_id: string; // "" = free text, no catalog item
  description: string;
  qty: string;
  unit_price: string;
};

const eur = (n: string | number) => `€${Number(n).toFixed(2)}`;
let keySeq = 0;
const newKey = () => `l${++keySeq}`;

export function QuoteDetail({
  quote,
  catalogItems,
}: {
  quote: Quote;
  catalogItems: CatalogItem[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [linesSaved, setLinesSaved] = useState(false);
  const [status, setStatus] = useState(quote.status);
  const [savingLines, setSavingLines] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [creatingJob, setCreatingJob] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { label: statusLabel, tone: statusTone } = quoteStatusLabel(status);

  function addLine() {
    setLinesSaved(false);
    setLines((ls) => [
      ...ls,
      { key: newKey(), item_id: "", description: "", qty: "1", unit_price: "0" },
    ]);
  }

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLinesSaved(false);
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: string) {
    setLinesSaved(false);
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

  function pickCatalogItem(key: string, itemId: string) {
    const item = catalogItems.find((i) => i.id === itemId);
    setLinesSaved(false);
    setLines((ls) =>
      ls.map((l) =>
        l.key === key
          ? { ...l, item_id: itemId, description: item ? item.name : l.description }
          : l
      )
    );
  }

  async function saveLines() {
    setError(null);
    setSavingLines(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: rpcError } = await supabase.rpc("rpc_quote_lines_replace", {
        p_quote_id: quote.id,
        p_lines: lines.map((l) => ({
          item_id: l.item_id || undefined,
          description: l.description.trim(),
          qty: Number(l.qty),
          unit_price: Number(l.unit_price),
        })),
      });
      if (rpcError) throw rpcError;
      if (data.kind !== "ok") throw new Error(data.kind);
      setLinesSaved(true);
    } catch {
      setError("Não foi possível guardar as linhas. Tente novamente.");
    } finally {
      setSavingLines(false);
    }
  }

  async function accept() {
    setError(null);
    setAccepting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: rpcError } = await supabase.rpc("rpc_quote_accept", {
        p_quote_id: quote.id,
      });
      if (rpcError) throw rpcError;
      if (data.kind === "ok") {
        setStatus(data.status);
      } else if (data.kind === "conflict") {
        setError("Este orçamento já foi finalizado.");
      } else {
        setError("Não foi possível aceitar o orçamento. Tente novamente.");
      }
    } catch {
      setError("Não foi possível aceitar o orçamento. Tente novamente.");
    } finally {
      setAccepting(false);
    }
  }

  async function createJob() {
    setError(null);
    setCreatingJob(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: rpcError } = await supabase.rpc("rpc_create_job_from_quote", {
        p_quote_id: quote.id,
      });
      if (rpcError) throw rpcError;
      if (data.kind !== "ok") throw new Error(data.kind);
      router.push(`/office/jobs/${data.job_id}`);
    } catch {
      setError("Não foi possível criar o trabalho. Tente novamente.");
      setCreatingJob(false);
    }
  }

  // Require lines to actually be persisted (not just drafted client-side)
  // before allowing Aceitar — "once lines exist" means on the server, not
  // just in this unsaved form state.
  const canAccept = ["draft", "sent"].includes(status) && linesSaved && lines.length > 0;

  return (
    <div className="space-y-5">
      <div className="bg-white rounded border border-zinc-200 p-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <Pill tone={statusTone}>{statusLabel}</Pill>
          <div className="text-sm font-mono tabular-nums text-zinc-600">
            {Number(quote.quoted_hours).toFixed(1)} h · {eur(quote.quoted_materials)}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {status === "accepted" ? (
            <button
              onClick={createJob}
              disabled={creatingJob}
              className="flex items-center gap-1.5 rounded bg-cyan-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-cyan-700 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              {creatingJob ? "A criar trabalho…" : "Criar trabalho"}
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={accept}
              disabled={!canAccept || accepting}
              title={
                !canAccept
                  ? "Adicione e guarde pelo menos uma linha antes de aceitar"
                  : undefined
              }
              className="flex items-center gap-1.5 rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" />
              {accepting ? "A aceitar…" : "Aceitar"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="bg-white rounded border border-zinc-200">
        <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900">Linhas do orçamento (BOM)</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Substituição total — guardar envia a lista completa.
            </p>
          </div>
          <button
            onClick={addLine}
            className="flex items-center gap-1 rounded border border-zinc-300 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400"
          >
            <Plus className="w-3.5 h-3.5" />
            Adicionar linha
          </button>
        </div>

        <div className="p-4">
          <div className="mb-3 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-600" />
            <span>
              A API ainda não expõe uma forma de consultar as linhas já guardadas
              (não existe <span className="font-mono">GET /quotes/:id/lines</span>) — esta lista
              começa vazia a cada visita. Guardar substitui sempre a lista completa no servidor.
            </span>
          </div>

          {lines.length === 0 ? (
            <p className="text-sm text-zinc-500">Sem linhas. Adicione pelo menos uma.</p>
          ) : (
            <div className="space-y-2">
              {lines.map((l) => (
                <div key={l.key} className="flex items-center gap-2 flex-wrap">
                  <select
                    value={l.item_id}
                    onChange={(e) => pickCatalogItem(l.key, e.target.value)}
                    className="rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-700 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                  >
                    <option value="">Texto livre</option>
                    {catalogItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.sku} — {i.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    required
                    value={l.description}
                    onChange={(e) => updateLine(l.key, { description: e.target.value })}
                    placeholder="Descrição"
                    className="flex-1 min-w-[10rem] rounded border border-zinc-300 px-2 py-1.5 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    value={l.qty}
                    onChange={(e) => updateLine(l.key, { qty: e.target.value })}
                    className="w-20 rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                    placeholder="Qtd"
                  />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={l.unit_price}
                    onChange={(e) => updateLine(l.key, { unit_price: e.target.value })}
                    className="w-24 rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                    placeholder="Preço"
                  />
                  <button
                    onClick={() => removeLine(l.key)}
                    className="text-zinc-400 hover:text-red-600 p-1.5"
                    aria-label="Remover linha"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={saveLines}
              disabled={
                savingLines ||
                lines.length === 0 ||
                lines.some((l) => !l.description.trim() || Number(l.qty) <= 0)
              }
              className="flex items-center gap-1.5 rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              <Save className="w-4 h-4" />
              {savingLines ? "A guardar…" : "Guardar linhas"}
            </button>
            {linesSaved && (
              <span className="flex items-center gap-1 text-sm text-green-700">
                <CheckCircle2 className="w-4 h-4" />
                Guardado
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
