/*
 * Suppliers — real page (07-phase4-cost-intelligence.md §3-5). §6 Step 5:
 * the initial supplier list + catalog items (needed by the manual
 * add-price form's item picker) now come straight from Supabase; the rest
 * — selection, price table, add-price form, receipt upload/review/confirm
 * — is genuinely interactive, so it lives in the client component below
 * (which itself is a mix: price reads/writes are Supabase-native,
 * refresh-places/receipt upload/receipt confirm stay Fastify — see that
 * file's own comment). Structure ported from fieldready-prototype.jsx's
 * <Suppliers>: supplier card grid, selected supplier detail
 * (address/phone/hours + open state), price table with a "Digitalizar
 * recibo" action.
 */

import { Store } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SuppliersClient } from "./_components/suppliers-client";

export default async function SuppliersPage() {
  const supabase = await createSupabaseServerClient();
  const [{ data: suppliers, error: suppliersError }, { data: catalogItems, error: catalogError }] =
    await Promise.all([
      supabase
        .from("supplier")
        .select("id, tenant_id, name, category, address, phone, account_note, place_id, distance_km, synced_at, hours, created_at")
        .order("name", { ascending: true }),
      supabase.from("catalog_item").select("id, sku, name, unit").order("name", { ascending: true }),
    ]);
  if (suppliersError) throw suppliersError;
  if (catalogError) throw catalogError;

  const allSuppliers = suppliers ?? [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Store className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Fornecedores</h1>
      </div>

      {allSuppliers.length === 0 ? (
        <div className="bg-white rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
          Ainda não existem fornecedores.
        </div>
      ) : (
        <SuppliersClient initialSuppliers={allSuppliers} catalogItems={catalogItems ?? []} />
      )}
    </div>
  );
}
