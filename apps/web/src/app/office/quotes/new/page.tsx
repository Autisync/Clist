/*
 * Create-quote page. §6 Step 5: client list read straight from Supabase,
 * handed to the Client Component form, which now calls rpc_quote_create
 * (server-side created_by attribution — see that RPC's own comment) and
 * redirects to the new quote's detail page.
 */

import { Receipt } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NewQuoteForm } from "./_components/new-quote-form";

export default async function NewQuotePage() {
  const supabase = await createSupabaseServerClient();
  const { data: clients, error } = await supabase.from("client").select("id, name");
  if (error) throw error;

  const allClients = clients ?? [];

  return (
    <div className="max-w-xl space-y-5">
      <div className="flex items-center gap-2">
        <Receipt className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Novo orçamento</h1>
      </div>

      {allClients.length === 0 ? (
        <div className="bg-white rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Ainda não existem clientes.{" "}
          <a href="/office/clients" className="underline font-medium">
            Crie um cliente primeiro
          </a>
          .
        </div>
      ) : (
        <NewQuoteForm clients={allClients} />
      )}
    </div>
  );
}
