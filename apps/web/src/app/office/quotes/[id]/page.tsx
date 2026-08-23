/*
 * Quote detail — line-item editor, accept, create-job.
 *
 * There is no GET /quotes/:id or GET /quotes/:id/lines route in apps/api
 * (checked apps/api/src/routes/quotes.ts — only GET /quotes (list),
 * PATCH .../lines, POST .../accept, POST .../create-job exist). So:
 *   - the quote header is found by fetching GET /quotes and filtering by
 *     id client-side on the server (small tenant-scoped list, not a
 *     real N+1 concern);
 *   - the line-item editor has no existing lines to prefill from — it
 *     starts empty and the whole array is submitted as one PATCH
 *     (full-replace semantics), exactly as the build task specifies.
 *     QuoteDetail (the client component) surfaces this as a small note so
 *     it doesn't read as a bug.
 */

import { notFound } from "next/navigation";
import { Receipt } from "lucide-react";
import { serverApiFetch, ApiError } from "@/lib/api";
import { QuoteDetail } from "./_components/quote-detail";
import { FastifyUnavailable } from "../../_components/fastify-unavailable";

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

type Client = { id: string; name: string; address: string | null };
type CatalogItem = { id: string; sku: string; name: string; unit: string };

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let quotes: Quote[];
  let clients: Client[];
  let catalog_items: CatalogItem[];
  try {
    [{ quotes }, { clients }, { catalog_items }] = await Promise.all([
      serverApiFetch<{ quotes: Quote[] }>("/quotes"),
      serverApiFetch<{ clients: Client[] }>("/clients"),
      serverApiFetch<{ catalog_items: CatalogItem[] }>("/catalog-items"),
    ]);
  } catch (err) {
    if (err instanceof ApiError) return <FastifyUnavailable pageLabel="O detalhe do orçamento" />;
    throw err;
  }

  const quote = quotes.find((q) => q.id === id);
  if (!quote) notFound();

  const client = clients.find((c) => c.id === quote.client_id) ?? null;

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-2">
        <Receipt className="w-5 h-5 text-cyan-600" />
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">
            {client?.name || "Cliente desconhecido"}
          </h1>
          <p className="text-xs text-zinc-500">{quote.job_type}</p>
        </div>
      </div>

      <QuoteDetail quote={quote} catalogItems={catalog_items} />
    </div>
  );
}
