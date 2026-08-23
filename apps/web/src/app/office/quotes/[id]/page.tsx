/*
 * Quote detail — line-item editor, accept, create-job. §6 Step 5: reads now
 * go straight to Supabase — the quote row fetched directly by id (RLS
 * scopes it, .maybeSingle() + notFound() covers "doesn't exist or isn't
 * mine"), client name and catalog items each their own direct
 * `.from(...)` query. No v_quote_lines view or equivalent exists yet, so
 * the line-item editor still has no existing lines to prefill from — it
 * starts empty and the whole array is submitted as one call
 * (rpc_quote_lines_replace's full-replace semantics), exactly as before.
 * QuoteDetail (the client component) surfaces this as a small note so it
 * doesn't read as a bug.
 */

import { notFound } from "next/navigation";
import { Receipt } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { QuoteDetail } from "./_components/quote-detail";

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

export default async function QuoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: quote, error: quoteError } = await supabase
    .from("quote")
    .select("id, client_id, job_type, quoted_hours, quoted_materials, status, accepted_at, created_at")
    .eq("id", id)
    .maybeSingle();
  if (quoteError) throw quoteError;
  if (!quote) notFound();

  const [{ data: client, error: clientError }, { data: catalogItems, error: catalogError }] =
    await Promise.all([
      supabase.from("client").select("id, name").eq("id", quote.client_id).maybeSingle(),
      supabase.from("catalog_item").select("id, sku, name, unit").order("name", { ascending: true }),
    ]);
  if (clientError) throw clientError;
  if (catalogError) throw catalogError;

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

      <QuoteDetail quote={quote as Quote} catalogItems={catalogItems ?? []} />
    </div>
  );
}
