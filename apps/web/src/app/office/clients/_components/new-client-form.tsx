"use client";

/*
 * Create-client form. POST /clients, then router.refresh() so the
 * server-fetched list on the parent page re-runs and picks up the new row
 * — no client-side list state to keep in sync by hand.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, UserPlus } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

export function NewClientForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch("/clients", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          address: address.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
        }),
      });
      setName("");
      setAddress("");
      setPhone("");
      setEmail("");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError("Dados inválidos — verifique o nome e o email.");
      } else {
        setError("Não foi possível criar o cliente. Tente novamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white rounded border border-zinc-200 p-4 h-fit">
      <div className="flex items-center gap-2 mb-3">
        <UserPlus className="w-4 h-4 text-cyan-600" />
        <h2 className="text-sm font-semibold text-zinc-900">Novo cliente</h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label htmlFor="name" className="block text-xs font-medium text-zinc-600 mb-1">
            Nome
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="Nome do cliente"
          />
        </div>

        <div>
          <label htmlFor="address" className="block text-xs font-medium text-zinc-600 mb-1">
            Morada
          </label>
          <input
            id="address"
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="Rua, número, localidade"
          />
        </div>

        <div>
          <label htmlFor="phone" className="block text-xs font-medium text-zinc-600 mb-1">
            Telefone
          </label>
          <input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="912 345 678"
          />
        </div>

        <div>
          <label htmlFor="email" className="block text-xs font-medium text-zinc-600 mb-1">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
            placeholder="cliente@exemplo.pt"
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="w-full rounded bg-zinc-900 text-white text-sm font-medium py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "A criar…" : "Criar cliente"}
        </button>
      </form>
    </div>
  );
}
