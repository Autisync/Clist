/*
 * Cost summary export — third of the three "bigger product improvements"
 * (per-technician analytics, client portal, invoicing/e-fatura), scoped
 * deliberately narrow per the user's own choice: a non-fiscal cost
 * summary, NOT a real invoice. Portugal requires software to be
 * AT-certified to issue fiscally valid invoices/faturas; this app isn't,
 * and building toward "looks like an invoice" without that certification
 * would be actively misleading to whoever receives it. This page is
 * labelled as exactly what it is — an internal/handout cost breakdown —
 * both on screen and in the printed output, and stays that way; if real
 * fiscal invoicing is ever wanted, that's a certified-provider
 * integration, a different and much bigger feature, not an extension of
 * this one.
 *
 * Deliberately a plain server-rendered page + window.print() rather than
 * a new Playwright-generated PDF route (the pattern REF assembly already
 * uses, domain/ref.ts): no new binary-generation dependency, no new
 * Fastify route/attack surface, and every browser's native
 * print-to-PDF already produces a perfectly good PDF from clean HTML.
 * Reads go straight to Supabase (RLS-scoped), same cutover as the parent
 * job-detail page.
 */

import { notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PrintButton } from "./_components/print-button";

type QuoteLine = {
  id: string;
  description: string;
  qty: string;
  unit_price: string;
};

function eur(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}

export default async function CostSummaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: job, error: jobError } = await supabase
    .from("job")
    .select(
      "id, tenant_id, quote_id, client_id, code, title, job_type, scheduled_at, quoted_hours, quoted_materials, actual_hours, actual_materials, created_at"
    )
    .eq("id", id)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) notFound();

  const [
    { data: client, error: clientError },
    { data: tenant, error: tenantError },
    { data: quoteLines, error: quoteLinesError },
  ] = await Promise.all([
    supabase.from("client").select("name, address").eq("id", job.client_id).maybeSingle(),
    supabase.from("tenant").select("name").eq("id", job.tenant_id).maybeSingle(),
    job.quote_id
      ? supabase
          .from("quote_line")
          .select("id, description, qty, unit_price")
          .eq("quote_id", job.quote_id)
          .order("description")
      : Promise.resolve({ data: [] as QuoteLine[], error: null }),
  ]);
  if (clientError) throw clientError;
  if (tenantError) throw tenantError;
  if (quoteLinesError) throw quoteLinesError;

  const lines = (quoteLines ?? []) as QuoteLine[];
  const lineTotals = lines.map((l) => Number(l.qty) * Number(l.unit_price));
  const itemsTotal = lineTotals.reduce((sum, t) => sum + t, 0);

  const quotedHours = Number(job.quoted_hours);
  const quotedMaterials = Number(job.quoted_materials);
  const actualHours = job.actual_hours !== null ? Number(job.actual_hours) : null;
  const actualMaterials = job.actual_materials !== null ? Number(job.actual_materials) : null;

  return (
    <div className="max-w-2xl mx-auto space-y-5 print:max-w-none">
      <div className="flex items-center justify-between print:hidden">
        <h1 className="text-lg font-semibold text-zinc-900">Resumo de custos</h1>
        <PrintButton />
      </div>

      <div className="bg-amber-50 border border-amber-300 rounded p-3 text-xs text-amber-900 leading-relaxed">
        <strong>Este documento não é uma fatura.</strong> É um resumo interno de
        custos, sem valor fiscal. Para efeitos fiscais, deve ser emitida fatura
        através de software certificado pela Autoridade Tributária (AT).
      </div>

      <div className="bg-white border border-zinc-200 rounded p-5 space-y-5 print:border-0 print:p-0">
        <div className="flex items-start justify-between border-b border-zinc-200 pb-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900">{tenant?.name ?? "—"}</div>
            <div className="text-xs text-zinc-500 mt-0.5">Resumo de custos (não fiscal)</div>
          </div>
          <div className="text-right text-xs text-zinc-500">
            <div className="font-mono">{job.code}</div>
            <div>
              {new Date(job.created_at as string).toLocaleDateString("pt-PT", {
                dateStyle: "long",
              })}
            </div>
          </div>
        </div>

        <div>
          <div className="text-xs text-zinc-500">Cliente</div>
          <div className="text-sm font-medium text-zinc-900">{client?.name ?? "Cliente desconhecido"}</div>
          {client?.address && <div className="text-xs text-zinc-500">{client.address}</div>}
        </div>

        <div>
          <div className="text-xs text-zinc-500 mb-1">Trabalho</div>
          <div className="text-sm text-zinc-900">{job.title}</div>
          <div className="text-xs text-zinc-500">{job.job_type}</div>
        </div>

        <div>
          <div className="text-xs font-semibold text-zinc-700 mb-2">Materiais</div>
          {lines.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-500 border-b border-zinc-200">
                  <th className="font-normal pb-1.5">Descrição</th>
                  <th className="font-normal pb-1.5 text-right">Qtd.</th>
                  <th className="font-normal pb-1.5 text-right">Preço unit.</th>
                  <th className="font-normal pb-1.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={l.id} className="border-b border-zinc-100">
                    <td className="py-1.5">{l.description}</td>
                    <td className="py-1.5 text-right tabular-nums">{Number(l.qty)}</td>
                    <td className="py-1.5 text-right tabular-nums">{eur(l.unit_price)}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{eur(lineTotals[i])}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="pt-2 text-right text-xs text-zinc-500">
                    Total materiais (orçamentado)
                  </td>
                  <td className="pt-2 text-right font-semibold tabular-nums">{eur(itemsTotal)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <div className="flex justify-between text-sm">
              <span className="text-zinc-600">Materiais (orçamentado, sem trabalho de orçamento associado)</span>
              <span className="font-medium tabular-nums">{eur(quotedMaterials)}</span>
            </div>
          )}
          {actualMaterials !== null && (
            <div className="flex justify-between text-sm mt-2 pt-2 border-t border-zinc-100">
              <span className="text-zinc-600">Materiais reais</span>
              <span className="font-medium tabular-nums">
                {eur(actualMaterials)}
                <span className={`ml-1.5 text-xs ${actualMaterials > quotedMaterials ? "text-red-600" : "text-green-600"}`}>
                  ({actualMaterials > quotedMaterials ? "+" : ""}
                  {eur(actualMaterials - quotedMaterials)})
                </span>
              </span>
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-zinc-200">
          <div className="text-xs font-semibold text-zinc-700 mb-2">Horas</div>
          <div className="flex justify-between text-sm">
            <span className="text-zinc-600">Orçamentadas</span>
            <span className="font-medium tabular-nums">{quotedHours.toFixed(1)} h</span>
          </div>
          {actualHours !== null && (
            <div className="flex justify-between text-sm mt-1">
              <span className="text-zinc-600">Reais</span>
              <span className="font-medium tabular-nums">
                {actualHours.toFixed(1)} h
                <span className={`ml-1.5 text-xs ${actualHours > quotedHours ? "text-red-600" : "text-green-600"}`}>
                  ({actualHours > quotedHours ? "+" : ""}
                  {(actualHours - quotedHours).toFixed(1)} h)
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="text-center text-[10px] text-zinc-400 leading-relaxed">
        Documento não fiscal, gerado por FieldReady em {new Date().toLocaleDateString("pt-PT")}.
        Não substitui fatura, fatura-recibo ou qualquer outro documento emitido por
        software certificado pela Autoridade Tributária.
      </div>
    </div>
  );
}
