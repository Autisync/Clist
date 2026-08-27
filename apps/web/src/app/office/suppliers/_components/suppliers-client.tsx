"use client";

/*
 * Suppliers interactive shell — 07-phase4-cost-intelligence.md §3-5,
 * 04-API-SPEC.md §3. Ports fieldready-prototype.jsx's <Suppliers>
 * structure (supplier card grid → selected supplier detail + price table)
 * wired to the real API instead of the prototype's mock `prices`/`SUPPLIERS`
 * arrays, plus the receipt upload → review → confirm flow
 * (07-phase4-cost-intelligence.md §5's human-in-the-loop step) that the
 * prototype only faked with a canned FAKE_RECEIPT.
 *
 * §6 Step 5: price reads and manual price entry now go straight to
 * Supabase (rpc_supplier_price_record — see rpc.sql's own comment for why
 * that one needed an RPC, not a plain insert). refresh-places (external
 * Google Places call), receipt upload (Veryfi OCR), and receipt confirm
 * all stay Fastify-backed — none of the three can be a plain RLS-scoped
 * write, same "structurally can't be an RPC" reasoning as REF PDF
 * generation (08-supabase-native-migration.md §4).
 */

import { useEffect, useState } from "react";
import {
  MapPin,
  RefreshCw,
  Receipt,
  Plus,
  PlusCircle,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Store,
} from "lucide-react";
import { apiFetch, uploadReceipt, ApiError } from "@/lib/api";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Pill } from "../../_components/pill";
import { openState } from "@/lib/sourcing";

export type SupplierHoursSlot = { dow: number; open: string; close: string } | null;

export type Supplier = {
  id: string;
  tenant_id: string;
  name: string;
  category: string | null;
  address: string | null;
  phone: string | null;
  account_note: string | null;
  place_id: string | null;
  distance_km: number | string | null;
  synced_at: string | null;
  hours: SupplierHoursSlot[] | null;
  created_at: string;
};

export type CatalogItem = { id: string; sku: string; name: string; unit: string };

type SupplierPrice = {
  id: string;
  tenant_id: string;
  supplier_id: string;
  item_id: string;
  price: string;
  prev_price: string | null;
  source: string;
  effective_at: string;
  receipt_id: string | null;
  created_by: string | null;
  item_sku: string;
  item_name: string;
  item_unit: string;
};

type ReceiptLine = {
  id: string;
  tenant_id: string;
  receipt_id: string;
  item_id: string | null;
  description: string;
  qty: string;
  unit_price: string;
};

const eur = (n: string | number) => `€${Number(n).toFixed(2)}`;
const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

export function SuppliersClient({
  initialSuppliers,
  catalogItems,
}: {
  initialSuppliers: Supplier[];
  catalogItems: CatalogItem[];
}) {
  const [suppliers, setSuppliers] = useState(initialSuppliers);
  const [selectedId, setSelectedId] = useState<string | null>(initialSuppliers[0]?.id ?? null);
  const selected = suppliers.find((s) => s.id === selectedId) ?? suppliers[0];

  // new-supplier form — a plain RLS-scoped insert (supplier.tenant_id
  // defaults to fn_current_tenant_id(), schema.sql's own tenant_tables
  // loop), same "no RPC needed, defaults cover attribution" reasoning as
  // office/support's own ticket-creation form. This is the ONLY way a
  // tenant can ever get their first supplier — previously there was no
  // create path in this component at all.
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPlaceId, setNewPlaceId] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [createSupplierError, setCreateSupplierError] = useState<string | null>(null);

  const [prices, setPrices] = useState<SupplierPrice[]>([]);
  const [pricesLoading, setPricesLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // add-price form
  const [addItemId, setAddItemId] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // receipt upload/review/confirm
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptDocNumber, setReceiptDocNumber] = useState("");
  const [receiptDate, setReceiptDate] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ id: string; lines: ReceiptLine[]; ocr_failed?: boolean } | null>(null);
  const [checkedLines, setCheckedLines] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState<number | null>(null);

  // §6 Step 5: reads straight from Supabase — same join GET
  // /suppliers/:id/prices did server-side, done here via supabase-js's
  // embedded-resource syntax instead (catalog_item(sku, name, unit) off
  // item_id's FK), then flattened back to the item_sku/item_name/item_unit
  // shape the rest of this component already expects, so nothing else
  // here needs to change.
  async function loadPrices(supplierId: string) {
    setPricesLoading(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("supplier_price")
        .select(
          "id, tenant_id, supplier_id, item_id, price, prev_price, source, effective_at, receipt_id, created_by, catalog_item(sku, name, unit)"
        )
        .eq("supplier_id", supplierId)
        .order("catalog_item(name)", { ascending: true });
      if (error) throw error;
      const rows: SupplierPrice[] = (data ?? []).map((p) => {
        const item = Array.isArray(p.catalog_item) ? p.catalog_item[0] : p.catalog_item;
        return {
          id: p.id,
          tenant_id: p.tenant_id,
          supplier_id: p.supplier_id,
          item_id: p.item_id,
          price: p.price,
          prev_price: p.prev_price,
          source: p.source,
          effective_at: p.effective_at,
          receipt_id: p.receipt_id,
          created_by: p.created_by,
          item_sku: item?.sku ?? "",
          item_name: item?.name ?? "",
          item_unit: item?.unit ?? "",
        };
      });
      setPrices(rows);
    } catch {
      setPrices([]);
    } finally {
      setPricesLoading(false);
    }
  }

  useEffect(() => {
    if (!selectedId) return; // zero suppliers yet — nothing to load
    void loadPrices(selectedId);
    // Selecting a different supplier clears any in-progress receipt review
    // — a scan is scoped to the supplier it was uploaded for.
    setReceipt(null);
    setCheckedLines(new Set());
    setConfirmedCount(null);
    setUploadError(null);
    setConfirmError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  function selectSupplier(id: string) {
    setSelectedId(id);
  }

  async function createSupplier(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreatingSupplier(true);
    setCreateSupplierError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("supplier")
        .insert({
          name: newName.trim(),
          category: newCategory.trim() || null,
          address: newAddress.trim() || null,
          phone: newPhone.trim() || null,
          place_id: newPlaceId.trim() || null,
        })
        .select(
          "id, tenant_id, name, category, address, phone, account_note, place_id, distance_km, synced_at, hours, created_at"
        )
        .single();
      if (error) throw error;
      const created = data as Supplier;
      setSuppliers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedId(created.id);
      setShowNewForm(false);
      setNewName("");
      setNewCategory("");
      setNewAddress("");
      setNewPhone("");
      setNewPlaceId("");
    } catch {
      setCreateSupplierError("Não foi possível criar o fornecedor. Tente novamente.");
    } finally {
      setCreatingSupplier(false);
    }
  }

  async function refreshPlaces() {
    if (!selected.place_id) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const updated = await apiFetch<Supplier>(`/suppliers/${selected.id}/refresh-places`, {
        method: "POST",
      });
      setSuppliers((ss) => ss.map((s) => (s.id === updated.id ? updated : s)));
    } catch {
      setRefreshError("Não foi possível atualizar a partir do Google Places.");
    } finally {
      setRefreshing(false);
    }
  }

  async function submitAddPrice(e: React.FormEvent) {
    e.preventDefault();
    if (!addItemId || !addPrice) return;
    setAddError(null);
    setAddSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase.rpc("rpc_supplier_price_record", {
        p_supplier_id: selected.id,
        p_item_id: addItemId,
        p_price: Number(addPrice),
      });
      if (error) throw error;
      if (data.kind !== "ok") throw new Error(data.kind);
      setAddItemId("");
      setAddPrice("");
      await loadPrices(selected.id);
    } catch {
      setAddError("Não foi possível guardar o preço. Verifique o valor.");
    } finally {
      setAddSubmitting(false);
    }
  }

  async function submitReceipt(e: React.FormEvent) {
    e.preventDefault();
    if (!receiptFile) return;
    setUploadError(null);
    setUploading(true);
    try {
      const result = await uploadReceipt(receiptFile, {
        supplier_id: selected.id,
        doc_number: receiptDocNumber.trim() || undefined,
        receipt_date: receiptDate || undefined,
      });
      setReceipt(result);
      // Default: pre-check every matched line (item_id present) — the
      // "sem correspondência" ones stay unchecked and their checkbox stays
      // disabled, mirroring the prototype's receipt-review modal where
      // unmatched lines are shown but not actionable.
      setCheckedLines(new Set(result.lines.filter((l) => l.item_id).map((l) => l.id)));
      setConfirmedCount(null);
      setReceiptFile(null);
      setReceiptDocNumber("");
      setReceiptDate("");
    } catch {
      setUploadError("Não foi possível ler o recibo. Tente novamente.");
    } finally {
      setUploading(false);
    }
  }

  function toggleLine(id: string) {
    setCheckedLines((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirmReceipt() {
    if (!receipt || checkedLines.size === 0) return;
    setConfirmError(null);
    setConfirming(true);
    try {
      const result = await apiFetch<{ ok: boolean; supplier_prices: unknown[] }>(
        `/receipts/${receipt.id}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({ line_ids: Array.from(checkedLines) }),
        }
      );
      setConfirmedCount(result.supplier_prices.length);
      setReceipt(null);
      setCheckedLines(new Set());
      await loadPrices(selected.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setConfirmError("Recibo não encontrado.");
      } else {
        setConfirmError("Não foi possível confirmar os preços.");
      }
    } finally {
      setConfirming(false);
    }
  }

  const state = selected ? openState(selected.hours) : null;

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <button
          onClick={() => setShowNewForm((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-medium text-cyan-700 hover:text-cyan-800"
        >
          <PlusCircle className="w-4 h-4" />
          Novo fornecedor
        </button>
      </div>

      {showNewForm && (
        <form onSubmit={createSupplier} className="bg-white border border-zinc-200 rounded p-4 space-y-3">
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome do fornecedor"
              className="flex-1 min-w-[10rem] rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            />
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Categoria (opcional)"
              className="w-40 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            <input
              type="text"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value)}
              placeholder="Morada (opcional)"
              className="flex-1 min-w-[10rem] rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            />
            <input
              type="text"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Telefone (opcional)"
              className="w-40 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>
          <div>
            <input
              type="text"
              value={newPlaceId}
              onChange={(e) => setNewPlaceId(e.target.value)}
              placeholder="Google Place ID (opcional — permite sincronizar morada/horário)"
              className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            />
          </div>
          <div className="flex items-center justify-between">
            {createSupplierError && <span className="text-xs text-red-700">{createSupplierError}</span>}
            <button
              type="submit"
              disabled={creatingSupplier || !newName.trim()}
              className="ml-auto rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              {creatingSupplier ? "A criar…" : "Criar fornecedor"}
            </button>
          </div>
        </form>
      )}

      {suppliers.length === 0 ? (
        <div className="bg-white rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 flex items-center gap-2">
          <Store className="w-4 h-4 text-zinc-400" />
          Ainda não existem fornecedores.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {suppliers.map((sup) => {
            const st = openState(sup.hours);
            return (
              <button
                key={sup.id}
                onClick={() => selectSupplier(sup.id)}
                className={`text-left p-3 rounded border ${
                  selectedId === sup.id
                    ? "border-zinc-900 bg-white"
                    : "border-zinc-200 bg-white hover:border-zinc-400"
                }`}
              >
                <div className="text-sm font-medium leading-tight">{sup.name}</div>
                <div className="text-xs text-zinc-500 mt-1">{sup.category || "—"}</div>
                <div className="mt-2 flex items-center justify-between">
                  <Pill tone={st.open ? "green" : "red"}>{st.open ? "Aberto" : "Fechado"}</Pill>
                  <span className="text-xs text-zinc-500">
                    {sup.distance_km === null ? "—" : `${sup.distance_km} km`}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selected && state && (
      <>
      <div className="bg-white rounded border border-zinc-200">
        <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">{selected.name}</h3>
            {selected.category && <p className="text-xs text-zinc-500 mt-0.5">{selected.category}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Pill tone={state.open ? "green" : "red"}>{state.text}</Pill>
            {selected.place_id && (
              <button
                onClick={refreshPlaces}
                disabled={refreshing}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-600 border border-zinc-300 rounded hover:bg-zinc-50 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Atualizar
              </button>
            )}
          </div>
        </div>
        <div className="p-4 grid md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1.5">
            <div className="flex gap-2">
              <MapPin className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
              <span>{selected.address || "Sem morada"}</span>
            </div>
            <div className="text-zinc-500">
              {selected.phone || "Sem telefone"}
              {selected.distance_km !== null && ` · ${selected.distance_km} km da base`}
            </div>
            <div className="text-zinc-500">{selected.account_note || "—"}</div>
            {selected.place_id && (
              <div className="text-zinc-400 pt-1">
                Morada e horário sincronizados do Google Places · place_id{" "}
                <code className="text-zinc-500">{selected.place_id}</code>
                {selected.synced_at &&
                  ` · ${new Date(selected.synced_at).toLocaleString("pt-PT")}`}
              </div>
            )}
            {refreshError && <div className="text-red-600">{refreshError}</div>}
          </div>
          <div>
            <div className="font-medium text-zinc-700 mb-1">Horário</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              {DAYS.map((d, i) => {
                const slot = selected.hours?.[i];
                return (
                  <div key={d} className="flex justify-between">
                    <span className="text-zinc-500">{d}</span>
                    <span>{slot ? `${slot.open}–${slot.close}` : "Fechado"}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white rounded border border-zinc-200">
        <div className="px-4 py-3 border-b border-zinc-100 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900">Tabela de preços</h3>
            <p className="text-xs text-zinc-500 mt-0.5">
              Atualizada por digitalização de recibo ou manualmente
            </p>
          </div>
        </div>
        <div className="p-4 space-y-4">
          {pricesLoading ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> A carregar preços…
            </div>
          ) : prices.length === 0 ? (
            <p className="text-xs text-zinc-500">Sem preços registados para este fornecedor.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-zinc-500 border-b border-zinc-200">
                    <th className="py-1.5 pr-2">Artigo</th>
                    <th className="pr-2">SKU</th>
                    <th className="pr-2">Preço</th>
                    <th className="pr-2">Variação</th>
                    <th className="pr-2">Origem</th>
                    <th>Atualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => {
                    const prev = p.prev_price !== null ? Number(p.prev_price) : null;
                    const d = prev ? ((Number(p.price) - prev) / prev) * 100 : 0;
                    return (
                      <tr key={p.id} className="border-b border-zinc-100">
                        <td className="py-1.5 pr-2">{p.item_name}</td>
                        <td className="pr-2 font-mono text-zinc-500">{p.item_sku}</td>
                        <td className="pr-2 font-mono tabular-nums font-medium">{eur(p.price)}</td>
                        <td className="pr-2 font-mono tabular-nums">
                          {d === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <span className={d > 0 ? "text-red-600" : "text-green-600"}>
                              {d > 0 ? "+" : ""}
                              {d.toFixed(1)}%
                            </span>
                          )}
                        </td>
                        <td className="pr-2">
                          <Pill tone={p.source === "receipt" ? "cyan" : "zinc"}>
                            {p.source === "receipt" ? "recibo" : "manual"}
                          </Pill>
                        </td>
                        <td className="text-zinc-500">
                          {new Date(p.effective_at).toLocaleDateString("pt-PT")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <form onSubmit={submitAddPrice} className="flex flex-wrap items-end gap-2 pt-3 border-t border-zinc-100">
            <div className="min-w-[200px]">
              <label className="block text-xs font-medium text-zinc-600 mb-1">Artigo</label>
              <select
                value={addItemId}
                onChange={(e) => setAddItemId(e.target.value)}
                className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600"
              >
                <option value="">Selecione um artigo</option>
                {catalogItems.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.sku})
                  </option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <label className="block text-xs font-medium text-zinc-600 mb-1">Preço (€)</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={addPrice}
                onChange={(e) => setAddPrice(e.target.value)}
                className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs font-mono text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600"
                placeholder="0.00"
              />
            </div>
            <button
              type="submit"
              disabled={addSubmitting || !addItemId || !addPrice}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white rounded text-xs font-medium hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" />
              {addSubmitting ? "A guardar…" : "Adicionar preço"}
            </button>
            {addError && (
              <div className="w-full flex items-center gap-1.5 text-xs text-red-600">
                <AlertTriangle className="w-3.5 h-3.5" /> {addError}
              </div>
            )}
          </form>
        </div>
      </div>

      <div className="bg-white rounded border border-zinc-200">
        <div className="px-4 py-3 border-b border-zinc-100">
          <h3 className="text-sm font-semibold text-zinc-900 flex items-center gap-2">
            <Receipt className="w-4 h-4" />
            Digitalizar recibo
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Upload → leitura automática (OCR) → confirmação manual antes de atualizar preços.
            Nenhum preço é escrito sem confirmação humana.
          </p>
        </div>
        <div className="p-4 space-y-4">
          {!receipt && (
            <form onSubmit={submitReceipt} className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Imagem do recibo</label>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-zinc-700"
                />
              </div>
              <div className="w-36">
                <label className="block text-xs font-medium text-zinc-600 mb-1">Nº documento</label>
                <input
                  type="text"
                  value={receiptDocNumber}
                  onChange={(e) => setReceiptDocNumber(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600"
                  placeholder="opcional"
                />
              </div>
              <div className="w-36">
                <label className="block text-xs font-medium text-zinc-600 mb-1">Data</label>
                <input
                  type="date"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                  className="w-full rounded border border-zinc-300 px-2 py-1.5 text-xs text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600"
                />
              </div>
              <button
                type="submit"
                disabled={uploading || !receiptFile}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white rounded text-xs font-medium hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed"
              >
                <Receipt className="w-3.5 h-3.5" />
                {uploading ? "A ler…" : "Digitalizar recibo"}
              </button>
              {uploadError && (
                <div className="w-full flex items-center gap-1.5 text-xs text-red-600">
                  <AlertTriangle className="w-3.5 h-3.5" /> {uploadError}
                </div>
              )}
            </form>
          )}

          {confirmedCount !== null && (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              {confirmedCount} {confirmedCount === 1 ? "preço atualizado" : "preços atualizados"} a partir
              do recibo.
            </div>
          )}

          {receipt?.ocr_failed && (
            <div className="border border-amber-300 bg-amber-50 text-amber-800 rounded p-2.5 text-xs">
              A leitura automática do recibo falhou (serviço indisponível ou demorou
              demasiado). O recibo foi guardado — adicione os preços manualmente acima em
              vez de confirmar linhas aqui.
            </div>
          )}

          {receipt && receipt.lines.length > 0 && (
            <div className="border border-zinc-200 rounded">
              <div className="px-3 py-2 border-b border-zinc-100 text-xs text-zinc-500">
                Confirme a correspondência antes de atualizar a tabela de preços — linhas sem
                artigo correspondente não podem ser confirmadas.
              </div>
              <div className="p-3 space-y-2">
                {receipt.lines.map((l) => {
                  const matchedItem = catalogItems.find((c) => c.id === l.item_id);
                  return (
                    <label
                      key={l.id}
                      className={`flex items-start gap-3 border rounded p-2.5 ${
                        l.item_id ? "border-zinc-200" : "border-zinc-100 bg-zinc-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checkedLines.has(l.id)}
                        disabled={!l.item_id}
                        onChange={() => toggleLine(l.id)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono text-zinc-500 truncate">{l.description}</div>
                        <div className="text-sm">
                          {matchedItem ? (
                            matchedItem.name
                          ) : (
                            <span className="text-zinc-400">sem correspondência — ignorar</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm font-medium">{eur(l.unit_price)}</div>
                        <div className="text-xs text-zinc-500">×{l.qty}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              <div className="px-3 py-2.5 border-t border-zinc-200 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setReceipt(null);
                    setCheckedLines(new Set());
                  }}
                  className="px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-900"
                >
                  Cancelar
                </button>
                <button
                  onClick={confirmReceipt}
                  disabled={confirming || checkedLines.size === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-900 text-white rounded text-xs font-medium disabled:bg-zinc-300 disabled:cursor-not-allowed"
                >
                  {confirming ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  )}
                  Confirmar {checkedLines.size} {checkedLines.size === 1 ? "preço" : "preços"}
                </button>
              </div>
              {confirmError && (
                <div className="px-3 pb-3 flex items-center gap-1.5 text-xs text-red-600">
                  <XCircle className="w-3.5 h-3.5" /> {confirmError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      </>
      )}
    </div>
  );
}
