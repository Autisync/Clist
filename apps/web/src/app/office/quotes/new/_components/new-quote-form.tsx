"use client";

/*
 * POST /quotes {client_id, job_type, quoted_hours, quoted_materials} —
 * on success, redirect straight to the new quote's detail page (where the
 * line-item editor / accept / create-job flow lives) rather than back to
 * the list.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

type Client = { id: string; name: string };

export function NewQuoteForm({ clients }: { clients: Client[] }) {
  const router = useRouter();
  const [clientId, setClientId] = useState(clients[0]?.id ?? "");
  const [jobType, setJobType] = useState("");
  const [quotedHours, setQuotedHours] = useState("");
  const [quotedMaterials, setQuotedMaterials] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { id } = await apiFetch<{ id: string }>("/quotes", {
        method: "POST",
        body: JSON.stringify({
          client_id: clientId,
          job_type: jobType.trim(),
          quoted_hours: Number(quotedHours),
          quoted_materials: Number(quotedMaterials),
        }),
      });
      router.push(`/office/quotes/${id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError("Dados inválidos — verifique os campos preenchidos.");
      } else {
        setError("Não foi possível criar o orçamento. Tente novamente.");
      }
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-zinc-200 rounded p-5 space-y-3">
      <div>
        <label htmlFor="client_id" className="block text-xs font-medium text-zinc-600 mb-1">
          Cliente
        </label>
        <select
          id="client_id"
          required
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
        >
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="job_type" className="block text-xs font-medium text-zinc-600 mb-1">
          Tipo de trabalho
        </label>
        <input
          id="job_type"
          type="text"
          required
          value={jobType}
          onChange={(e) => setJobType(e.target.value)}
          placeholder="Instalação antena TDT"
          className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="quoted_hours" className="block text-xs font-medium text-zinc-600 mb-1">
            Horas orçamentadas
          </label>
          <input
            id="quoted_hours"
            type="number"
            step="0.5"
            min="0"
            required
            value={quotedHours}
            onChange={(e) => setQuotedHours(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="4"
          />
        </div>
        <div>
          <label htmlFor="quoted_materials" className="block text-xs font-medium text-zinc-600 mb-1">
            Material orçamentado (€)
          </label>
          <input
            id="quoted_materials"
            type="number"
            step="0.01"
            min="0"
            required
            value={quotedMaterials}
            onChange={(e) => setQuotedMaterials(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="120.00"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || !clientId || !jobType.trim()}
        className="rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
      >
        {submitting ? "A criar…" : "Criar orçamento"}
      </button>
    </form>
  );
}
