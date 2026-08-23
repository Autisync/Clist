/*
 * Quote list. GET /quotes returns quote rows with client_id but no client
 * name (03-schema.sql §6's quote table has no denormalized name, and the
 * route does no join — checked apps/api/src/routes/quotes.ts), so this
 * page also fetches GET /clients once and joins client names in on the
 * server before rendering — two total requests, not N+1.
 */

import Link from "next/link";
import { Receipt, Plus } from "lucide-react";
import { serverApiFetch, ApiError } from "@/lib/api";
import { Pill, quoteStatusLabel } from "../_components/pill";
import { FastifyUnavailable } from "../_components/fastify-unavailable";

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

type Client = { id: string; name: string };

const eur = (n: string | number) => `€${Number(n).toFixed(2)}`;

export default async function QuotesPage() {
  let quotes: Quote[];
  let clients: Client[];
  try {
    [{ quotes }, { clients }] = await Promise.all([
      serverApiFetch<{ quotes: Quote[] }>("/quotes"),
      serverApiFetch<{ clients: Client[] }>("/clients"),
    ]);
  } catch (err) {
    if (err instanceof ApiError) return <FastifyUnavailable pageLabel="A lista de orçamentos" />;
    throw err;
  }

  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Receipt className="w-5 h-5 text-cyan-600" />
          <h1 className="text-lg font-semibold text-zinc-900">Orçamentos</h1>
        </div>
        <Link
          href="/office/quotes/new"
          className="flex items-center gap-1.5 rounded bg-zinc-900 text-white text-sm font-medium px-3 py-2 hover:bg-zinc-800 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Novo orçamento
        </Link>
      </div>

      <div className="bg-white rounded border border-zinc-200">
        {quotes.length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">Ainda não existem orçamentos.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-200">
                  <th className="py-2 px-4">Cliente</th>
                  <th className="py-2 px-4">Tipo de trabalho</th>
                  <th className="py-2 px-4">Horas</th>
                  <th className="py-2 px-4">Material</th>
                  <th className="py-2 px-4">Estado</th>
                  <th className="py-2 px-4">Criado</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => {
                  const { label, tone } = quoteStatusLabel(q.status);
                  return (
                    <tr key={q.id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
                      <td className="py-2 px-4">
                        <Link
                          href={`/office/quotes/${q.id}`}
                          className="font-medium text-zinc-900 hover:text-cyan-700"
                        >
                          {clientName.get(q.client_id) || "Cliente desconhecido"}
                        </Link>
                      </td>
                      <td className="py-2 px-4 text-zinc-600">{q.job_type}</td>
                      <td className="py-2 px-4 font-mono tabular-nums text-zinc-600">
                        {Number(q.quoted_hours).toFixed(1)} h
                      </td>
                      <td className="py-2 px-4 font-mono tabular-nums text-zinc-600">
                        {eur(q.quoted_materials)}
                      </td>
                      <td className="py-2 px-4">
                        <Pill tone={tone}>{label}</Pill>
                      </td>
                      <td className="py-2 px-4 text-zinc-500 font-mono tabular-nums">
                        {new Date(q.created_at).toLocaleDateString("pt-PT")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
