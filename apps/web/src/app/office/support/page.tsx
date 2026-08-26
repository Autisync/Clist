/*
 * Support — a tenant's own line to FieldReady's operators (schema.sql
 * §11a). Reads (own tickets + their messages) are plain RLS-scoped
 * `.from()` queries, same pattern as every other Supabase-native office
 * page — support_ticket's tenant_isolation policy is what actually scopes
 * this to the caller's own tenant, not anything this page does itself.
 */

import { LifeBuoy } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupportClient } from "./_components/support-client";

export default async function SupportPage() {
  const supabase = await createSupabaseServerClient();
  const { data: tickets, error } = await supabase
    .from("support_ticket")
    .select("id, subject, body, status, created_at, updated_at")
    .order("created_at", { ascending: false });
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
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-2">
        <LifeBuoy className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Suporte</h1>
      </div>
      <p className="text-sm text-zinc-500 -mt-3">
        Contacte a equipa FieldReady sobre um problema ou uma dúvida.
      </p>

      <SupportClient initialTickets={tickets ?? []} initialMessages={messages ?? []} />
    </div>
  );
}
