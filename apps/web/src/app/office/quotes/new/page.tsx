/*
 * Create-quote page. Client list is fetched server-side (for the client_id
 * select) and handed to the Client Component form, which does the actual
 * POST /quotes and redirect to the new quote's detail page.
 */

import { Receipt } from "lucide-react";
import { serverApiFetch, ApiError } from "@/lib/api";
import { NewQuoteForm } from "./_components/new-quote-form";
import { FastifyUnavailable } from "../../_components/fastify-unavailable";

type Client = { id: string; name: string };

export default async function NewQuotePage() {
  let clients: Client[];
  try {
    ({ clients } = await serverApiFetch<{ clients: Client[] }>("/clients"));
  } catch (err) {
    if (err instanceof ApiError) return <FastifyUnavailable pageLabel="A criação de orçamentos" />;
    throw err;
  }

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-2">
        <Receipt className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Novo orçamento</h1>
      </div>

      {clients.length === 0 ? (
        <div className="bg-white rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Ainda não existem clientes.{" "}
          <a href="/office/clients" className="underline font-medium">
            Crie um cliente primeiro
          </a>
          .
        </div>
      ) : (
        <NewQuoteForm clients={clients} />
      )}
    </div>
  );
}
