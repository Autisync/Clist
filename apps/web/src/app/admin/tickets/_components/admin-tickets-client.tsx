"use client";

/*
 * Cross-tenant ticket thread + status control, admin side. Status change
 * and reply are both plain RLS-scoped calls, same "no RPC needed" reasoning
 * as office's support-client.tsx: support_ticket_platform_admin_update
 * (schema.sql §11a) grants the update outright (no WITH CHECK beyond
 * fn_is_platform_admin(), since a platform admin changing status isn't
 * attribution-sensitive the way created_by/sender_* are), and
 * support_ticket_message_platform_admin_insert's WITH CHECK requires
 * sender_app_user_id is null and sender_platform_admin_id matches the
 * caller — both satisfied for free by that column's own
 * fn_current_platform_admin_id() default, so this insert omits both
 * sender columns entirely, same as the office side omits its own.
 */

import { useState } from "react";
import { Send, ChevronDown, ChevronUp } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Pill, type PillTone } from "../../../office/_components/pill";

type Ticket = {
  id: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
  tenant: { name: string; slug: string } | { name: string; slug: string }[] | null;
};

type Message = {
  id: string;
  ticket_id: string;
  body: string;
  created_at: string;
  sender_app_user_id: string | null;
  sender_platform_admin_id: string | null;
};

const STATUS_OPTIONS: { value: string; label: string; tone: PillTone }[] = [
  { value: "open", label: "Aberto", tone: "cyan" },
  { value: "in_progress", label: "Em curso", tone: "amber" },
  { value: "resolved", label: "Resolvido", tone: "green" },
  { value: "closed", label: "Fechado", tone: "zinc" },
];

function tenantOf(t: Ticket): { name: string; slug: string } | null {
  // Supabase's embedded-resource typing varies by client version/query
  // shape between a single object and a one-element array for a to-one
  // FK join — normalized here once rather than trusting either shape.
  return Array.isArray(t.tenant) ? (t.tenant[0] ?? null) : t.tenant;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AdminTicketsClient({
  initialTickets,
  initialMessages,
}: {
  initialTickets: Ticket[];
  initialMessages: Message[];
}) {
  const [tickets, setTickets] = useState(initialTickets);
  const [messages, setMessages] = useState(initialMessages);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [updatingStatusId, setUpdatingStatusId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);

  async function changeStatus(ticketId: string, status: string) {
    setUpdatingStatusId(ticketId);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.from("support_ticket").update({ status }).eq("id", ticketId);
      if (error) throw error;
      setTickets((prev) => prev.map((t) => (t.id === ticketId ? { ...t, status } : t)));
    } catch {
      // Left as-is on failure — the dropdown will just show the last
      // confirmed status again next render, a safe (not falsely-updated)
      // failure mode.
    } finally {
      setUpdatingStatusId(null);
    }
  }

  async function postReply(ticketId: string) {
    const body = (replyDrafts[ticketId] ?? "").trim();
    if (!body) return;
    setReplyingId(ticketId);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("support_ticket_message")
        .insert({ ticket_id: ticketId, body })
        .select("id, ticket_id, body, created_at, sender_app_user_id, sender_platform_admin_id")
        .single();
      if (error) throw error;
      setMessages((prev) => [...prev, data as Message]);
      setReplyDrafts((prev) => ({ ...prev, [ticketId]: "" }));
    } catch {
      // Draft kept on failure, same reasoning as office's support-client.
    } finally {
      setReplyingId(null);
    }
  }

  return (
    <div className="space-y-3">
      {tickets.length === 0 && (
        <div className="rounded border border-dashed border-zinc-800 p-6 text-sm text-zinc-500">
          Ainda não existem pedidos de suporte.
        </div>
      )}

      {tickets.map((ticket) => {
        const tenant = tenantOf(ticket);
        const status = STATUS_OPTIONS.find((s) => s.value === ticket.status) ?? STATUS_OPTIONS[0];
        const thread = messages
          .filter((m) => m.ticket_id === ticket.id)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        const expanded = expandedId === ticket.id;

        return (
          <div key={ticket.id} className="rounded border border-zinc-800 bg-zinc-900">
            <button
              onClick={() => setExpandedId(expanded ? null : ticket.id)}
              className="w-full flex items-center justify-between gap-3 p-4 text-left"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-zinc-100 truncate">{ticket.subject}</div>
                <div className="text-xs text-zinc-500 mt-0.5 font-mono">
                  {tenant?.name ?? "—"} · {formatDateTime(ticket.created_at)}
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Pill tone={status.tone}>{status.label}</Pill>
                {expanded ? (
                  <ChevronUp className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                )}
              </div>
            </button>

            {expanded && (
              <div className="border-t border-zinc-800 p-4 space-y-3">
                <div className="text-sm text-zinc-300 whitespace-pre-wrap">{ticket.body}</div>

                <div className="flex items-center gap-2 pt-2 border-t border-zinc-800">
                  <span className="text-xs text-zinc-500">Estado:</span>
                  <select
                    value={ticket.status}
                    onChange={(e) => changeStatus(ticket.id, e.target.value)}
                    disabled={updatingStatusId === ticket.id}
                    className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                {thread.length > 0 && (
                  <ul className="space-y-2 pt-2">
                    {thread.map((m) => {
                      const fromTeam = m.sender_platform_admin_id !== null;
                      return (
                        <li
                          key={m.id}
                          className={`rounded p-2.5 text-sm max-w-[85%] ${
                            fromTeam
                              ? "bg-amber-500/10 text-amber-100 ml-auto"
                              : "bg-zinc-800 text-zinc-200"
                          }`}
                        >
                          <div className="text-xs font-medium mb-1 opacity-70">
                            {fromTeam ? "Equipa FieldReady" : tenant?.name ?? "Cliente"}
                          </div>
                          <div className="whitespace-pre-wrap">{m.body}</div>
                          <div className="text-xs mt-1 opacity-60">{formatDateTime(m.created_at)}</div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="flex gap-2 pt-2">
                  <input
                    type="text"
                    value={replyDrafts[ticket.id] ?? ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") postReply(ticket.id);
                    }}
                    placeholder="Escrever uma resposta…"
                    className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                  <button
                    onClick={() => postReply(ticket.id)}
                    disabled={replyingId === ticket.id || !(replyDrafts[ticket.id] ?? "").trim()}
                    className="rounded bg-amber-600 text-black text-sm font-medium px-3 py-2 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-400 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {replyingId === ticket.id ? "…" : "Enviar"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
