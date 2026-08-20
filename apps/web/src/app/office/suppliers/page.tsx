/*
 * Suppliers — real page (07-phase4-cost-intelligence.md §3-5). Server
 * Component fetches the initial supplier list + catalog items (needed by
 * the manual add-price form's item picker); the rest — selection, price
 * table, add-price form, receipt upload/review/confirm — is genuinely
 * interactive, so it lives in the client component below. Structure ported
 * from fieldready-prototype.jsx's <Suppliers>: supplier card grid, selected
 * supplier detail (address/phone/hours + open state), price table with a
 * "Digitalizar recibo" action.
 */

import { Store } from "lucide-react";
import { serverApiFetch } from "@/lib/api";
import { SuppliersClient, type Supplier, type CatalogItem } from "./_components/suppliers-client";

export default async function SuppliersPage() {
  const [{ suppliers }, { catalog_items }] = await Promise.all([
    serverApiFetch<{ suppliers: Supplier[] }>("/suppliers"),
    serverApiFetch<{ catalog_items: CatalogItem[] }>("/catalog-items"),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Store className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Fornecedores</h1>
      </div>

      {suppliers.length === 0 ? (
        <div className="bg-white rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
          Ainda não existem fornecedores. Crie um em <code className="font-mono">POST /suppliers</code>.
        </div>
      ) : (
        <SuppliersClient initialSuppliers={suppliers} catalogItems={catalog_items} />
      )}
    </div>
  );
}
