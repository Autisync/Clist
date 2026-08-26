/*
 * Cross-tenant support ticket view — schema.sql §11a's
 * support_ticket_platform_admin_read/_update and
 * support_ticket_message_platform_admin_read/_insert additive policies are
 * what make this possible as plain `.from()` reads, same "no new backend
 * route needed for a read RLS already grants" reasoning as admin/page.tsx's
 * own tenant list. The embedded `tenant:tenant_id(name, slug)` select works
 * here for the same reason: tenant's own platform_admin_read_all_tenants
 * policy (§2b) lets this caller's identity see the parent tenant row too.
 */

import { LifeBuoy } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AdminTicketsClient } from "./_components/admin-tickets-client";

export default async function AdminTicketsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: tickets, error } = await supabase
    .from("support_ticket")
    .select("id, subject, body, status, created_at, updated_at, tenant:tenant_id(name, slug)")
    .order("updated_at", { ascending: false });
  if (error) throw error;

  const ticketIds = (tickets ?? []).map((t) => t.id);
  const { data: messages, error: messagesError } =
    ticketIds.length > 0
      ? await supabase
          .from("support_ticket_message")
          .select("id, ticket_id, body, created_at, sender_app_user_id, sender_platform_admin_id")
          .in("ticket_id", ticketIds)
          .order("created_at", { ascending: true })
      : { data: [], error: null };
  if (messagesError) throw messagesError;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <LifeBuoy className="w-5 h-5 text-amber-500" />
        <h1 className="text-lg font-semibold text-white">Pedidos de suporte</h1>
      </div>
      <p className="text-sm text-zinc-400 -mt-3">
        Pedidos de todas as empresas clientes.
      </p>

      <AdminTicketsClient initialTickets={tickets ?? []} initialMessages={messages ?? []} />
    </div>
  );
}
