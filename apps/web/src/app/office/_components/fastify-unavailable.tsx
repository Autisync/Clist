import { AlertTriangle } from "lucide-react";

/*
 * Shown instead of crashing when a still-Fastify-backed page's server-side
 * fetch fails — most commonly `unauthenticated` (ApiError, 401): §6 Step 5
 * (08-supabase-native-migration.md) deliberately runs two auth systems in
 * parallel mid-migration, and a session that only ever went through the
 * new Supabase-only /login page has no `fr_session` cookie at all, which
 * every route in this file's group still requires. That's an honest,
 * expected gap for a page not yet cut over — but it used to surface as an
 * uncaught ApiError crashing the whole Server Component render (a blank
 * "Application error" screen with no explanation), which reads as broken
 * rather than as "not migrated yet". This renders a real, calm message
 * instead, matching the same degraded-not-broken principle the rest of
 * this app already applies to compliance-profile gating.
 */
export function FastifyUnavailable({ pageLabel }: { pageLabel: string }) {
  return (
    <div className="max-w-xl mx-auto mt-12 rounded border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600 mt-0.5" />
        <div>
          <p className="font-medium">{pageLabel} ainda não está disponível nesta sessão.</p>
          <p className="mt-1.5 text-amber-800">
            Esta página ainda depende do sistema de autenticação antigo, que a
            migração para Supabase está a substituir gradualmente. A sua
            sessão atual (via login Supabase) não tem essa credencial — isto
            é uma limitação temporária da migração em curso, não um erro.
          </p>
        </div>
      </div>
    </div>
  );
}
