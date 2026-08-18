/*
 * Suppliers — placeholder page.
 *
 * fieldready-prototype.jsx's <Suppliers> tab (sourcing comparison, price
 * table, receipt scan) all read from the prototype's mock `SUPPLIERS`/
 * `PRICES` arrays. There is no supplier/price/receipt route in
 * apps/api/src/routes/*.ts today — that's Phase 4 scope
 * (07-phase4-cost-intelligence.md §1–2: supplier CRUD, price history, the
 * `v_*` price-alert view, and receipt OCR all land there together with the
 * dashboard). Nothing here is faked to fill the gap while that's unbuilt —
 * this is an honest "not yet", styled consistently with the rest of the
 * office UI rather than a broken-looking empty state.
 */

import { Store, Info } from "lucide-react";

export default function SuppliersPage() {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Store className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Fornecedores</h1>
      </div>

      <div className="bg-white rounded border border-dashed border-zinc-300 p-6">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-zinc-400 shrink-0 mt-0.5" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-700">Ainda não disponível</h3>
            <p className="text-sm text-zinc-500 mt-1.5 max-w-xl">
              Gestão de fornecedores, histórico de preços e leitura de recibos por OCR
              chegam na Fase 4, depois do ciclo de trabalhos (Fase 2) e da conformidade
              (Fase 3). Ainda não existe nenhuma rota de fornecedores/preços/recibos na
              API — esta página não mostra dados inventados enquanto isso não for
              construído.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
