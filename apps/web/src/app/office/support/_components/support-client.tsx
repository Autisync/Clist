"use client";

/*
 * Support ticket UI — schema.sql §11a. Both the "create ticket" and "post
 * reply" actions are plain RLS-scoped `.insert()` calls, no RPC: creation
 * relies on support_ticket.created_by's fn_current_app_user_id() default
 * (support-tickets-proof.mjs confirms a client-supplied override is
 * rejected by RLS, so leaving the column out of the insert payload here
 * isn't just convenience — it's the only value RLS actually accepts from
 * this side), and replies rely on support_ticket_message's matching
 * sender_app_user_id default plus its BEFORE INSERT trigger deriving
 * tenant_id from the parent ticket. Nothing here needs server-side
 * attribution beyond what those defaults already give for free.
 *
 * Messages carry only sender_app_user_id XOR sender_platform_admin_id
 * (CHECK, schema.sql §11a) — no display name. This office view only ever
 * sees its own tenant's threads, so the only two labels that matter are
 * "a colleague on this side" vs. "the FieldReady team on the other side";
 * resolving which specific office user sent which message would need a
 * join this page doesn't have a reason to do yet.
 */

import { useState } from "react";
import { LifeBuoy, Send, ChevronDown, ChevronUp, PlusCircle } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Pill, type PillTone } from "../../_components/pill";

type Ticket = {
  id: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type Message = {
  id: string;
  ticket_id: string;
  body: string;
  created_at: string;
  sender_app_user_id: string | null;
  sender_platform_admin_id: string | null;
};

const STATUS_LABEL: Record<string, { label: string; tone: PillTone }> = {
  open: { label: "Aberto", tone: "cyan" },
  in_progress: { label: "Em curso", tone: "amber" },
  resolved: { label: "Resolvido", tone: "green" },
  closed: { label: "Fechado", tone: "zinc" },
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SupportClient({
  initialTickets,
  initialMessages,
}: {
  initialTickets: Ticket[];
  initialMessages: Message[];
}) {
  const [tickets, setTickets] = useState(initialTickets);
  const [messages, setMessages] = useState(initialMessages);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const [showNewForm, setShowNewForm] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);

  async function createTicket(e: React.FormEvent) {
    e.preventDefault();
    if (!newSubject.trim() || !newBody.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      // created_by is intentionally omitted — support_ticket.created_by
      // defaults to fn_current_app_user_id(), and RLS's WITH CHECK rejects
      // any value that doesn't match the caller's own resolved identity
      // anyway (support-tickets-proof.mjs's spoof-rejection case), so
      // there's no value this client could usefully supply here.
      const { data, error } = await supabase
        .from("support_ticket")
        .insert({ subject: newSubject.trim(), body: newBody.trim() })
        .select("id, subject, body, status, created_at, updated_at")
        .single();
      if (error) throw error;
      setTickets((prev) => [data as Ticket, ...prev]);
      setNewSubject("");
      setNewBody("");
      setShowNewForm(false);
      setExpandedId(data.id);
    } catch {
      setCreateError("Não foi possível abrir o pedido de suporte. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  async function postReply(ticketId: string) {
    const body = (replyDrafts[ticketId] ?? "").trim();
    if (!body) return;
    setReplyingId(ticketId);
    try {
      const supabase = createSupabaseBrowserClient();
      // sender_app_user_id likewise omitted — same default + WITH CHECK
      // reasoning as created_by above. tenant_id is never sent at all:
      // fn_support_ticket_message_tenant_guard derives it server-side
      // from the parent ticket, the only place it's allowed to come from.
      const { data, error } = await supabase
        .from("support_ticket_message")
        .insert({ ticket_id: ticketId, body })
        .select("id, ticket_id, body, created_at, sender_app_user_id, sender_platform_admin_id")
        .single();
      if (error) throw error;
      setMessages((prev) => [...prev, data as Message]);
      setReplyDrafts((prev) => ({ ...prev, [ticketId]: "" }));
    } catch {
      // Left in the draft box on failure so the office user doesn't lose
      // what they typed — matches the technicians page's own preference
      // for a safe, retryable failure mode over a falsely-reassuring one.
    } finally {
      setReplyingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowNewForm((v) => !v)}
          className="flex items-center gap-1.5 text-sm font-medium text-cyan-700 hover:text-cyan-800"
        >
          <PlusCircle className="w-4 h-4" />
          Novo pedido
        </button>
      </div>

      {showNewForm && (
        <form onSubmit={createTicket} className="bg-white border border-zinc-200 rounded p-4 space-y-3">
          <input
            type="text"
            required
            value={newSubject}
            onChange={(e) => setNewSubject(e.target.value)}
            placeholder="Assunto"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
          <textarea
            required
            rows={4}
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            placeholder="Descreva o problema ou a dúvida"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
          <div className="flex items-center justify-between">
            {createError && <span className="text-xs text-red-700">{createError}</span>}
            <button
              type="submit"
              disabled={creating || !newSubject.trim() || !newBody.trim()}
              className="ml-auto rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              {creating ? "A enviar…" : "Enviar pedido"}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {tickets.length === 0 && (
          <div className="bg-white rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 flex items-center gap-2">
            <LifeBuoy className="w-4 h-4 text-zinc-400" />
            Ainda não abriu nenhum pedido de suporte.
          </div>
        )}

        {tickets.map((ticket) => {
          const status = STATUS_LABEL[ticket.status] ?? STATUS_LABEL.open;
          const thread = messages
            .filter((m) => m.ticket_id === ticket.id)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          const expanded = expandedId === ticket.id;

          return (
            <div key={ticket.id} className="bg-white border border-zinc-200 rounded">
              <button
                onClick={() => setExpandedId(expanded ? null : ticket.id)}
                className="w-full flex items-center justify-between gap-3 p-4 text-left"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-900 truncate">{ticket.subject}</div>
                  <div className="text-xs text-zinc-500 mt-0.5">
                    Aberto em {formatDateTime(ticket.created_at)}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <Pill tone={status.tone}>{status.label}</Pill>
                  {expanded ? (
                    <ChevronUp className="w-4 h-4 text-zinc-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-zinc-400" />
                  )}
                </div>
              </button>

              {expanded && (
                <div className="border-t border-zinc-100 p-4 space-y-3">
                  <div className="text-sm text-zinc-700 whitespace-pre-wrap">{ticket.body}</div>

                  {thread.length > 0 && (
                    <ul className="space-y-2 pt-2 border-t border-zinc-100">
                      {thread.map((m) => {
                        const fromTeam = m.sender_platform_admin_id !== null;
                        return (
                          <li
                            key={m.id}
                            className={`rounded p-2.5 text-sm max-w-[85%] ${
                              fromTeam
                                ? "bg-cyan-50 text-cyan-950 ml-auto"
                                : "bg-zinc-50 text-zinc-800"
                            }`}
                          >
                            <div className="text-xs font-medium mb-1 opacity-70">
                              {fromTeam ? "Equipa FieldReady" : "A sua equipa"}
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
                      onChange={(e) =>
                        setReplyDrafts((prev) => ({ ...prev, [ticket.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") postReply(ticket.id);
                      }}
                      placeholder="Escrever uma resposta…"
                      className="flex-1 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                    />
                    <button
                      onClick={() => postReply(ticket.id)}
                      disabled={replyingId === ticket.id || !(replyDrafts[ticket.id] ?? "").trim()}
                      className="rounded bg-cyan-600 text-white text-sm font-medium px-3 py-2 hover:bg-cyan-700 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
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
    </div>
  );
}
