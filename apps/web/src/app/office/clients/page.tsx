/*
 * Client list + create form. GET /clients (server-fetched, no query params
 * per the API map) and POST /clients (client-side form, see
 * _components/new-client-form.tsx). Table/Section visual structure follows
 * the Section/table pattern already established in
 * fieldready-prototype.jsx (JobList's "Histórico" table) rather than
 * inventing a new one.
 */

import { Users } from "lucide-react";
import { serverApiFetch } from "@/lib/api";
import { NewClientForm } from "./_components/new-client-form";

type Client = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
};

export default async function ClientsPage() {
  const { clients } = await serverApiFetch<{ clients: Client[] }>("/clients");

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Users className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Clientes</h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-white rounded border border-zinc-200">
          <div className="px-4 py-3 border-b border-zinc-100">
            <h2 className="text-sm font-semibold text-zinc-900">
              Todos os clientes{" "}
              <span className="font-mono tabular-nums text-zinc-400">({clients.length})</span>
            </h2>
          </div>
          {clients.length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">Ainda não existem clientes.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-500 border-b border-zinc-200">
                    <th className="py-2 px-4">Nome</th>
                    <th className="py-2 px-4">Morada</th>
                    <th className="py-2 px-4">Telefone</th>
                    <th className="py-2 px-4">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => (
                    <tr key={c.id} className="border-b border-zinc-100 last:border-0">
                      <td className="py-2 px-4 font-medium text-zinc-900">{c.name}</td>
                      <td className="py-2 px-4 text-zinc-600">{c.address || "—"}</td>
                      <td className="py-2 px-4 text-zinc-600 font-mono tabular-nums">
                        {c.phone || "—"}
                      </td>
                      <td className="py-2 px-4 text-zinc-600">{c.email || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <NewClientForm />
      </div>
    </div>
  );
}
