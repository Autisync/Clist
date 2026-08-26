"use client";

/*
 * Platform-admin login — schema.sql §2b. Structurally identical to
 * /login (office), same "settled palette, only what happens on submit
 * changes" reasoning, but deliberately a SEPARATE page rather than
 * branching the office login on fn_is_platform_admin() after sign-in: a
 * platform admin's identity is completely independent of any tenant (no
 * app_user row at all), so sharing one login form would mean deciding
 * "which surface do you mean" AFTER authenticating, for a surface
 * sensitive enough that a wrong guess is worth avoiding entirely rather
 * than handling gracefully. middleware.ts's /admin/* branch is what
 * actually enforces fn_is_platform_admin() — a non-admin who somehow
 * signs in here still gets bounced by it, same as any other stolen/wrong
 * credential would.
 */

import { useState } from "react";
import { Shield, AlertTriangle } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError("Credenciais inválidas.");
        return;
      }
      // Full navigation, not router.push — middleware.ts needs to
      // re-evaluate with the just-set Supabase session cookies present,
      // same reasoning /login and /field/login's own pages already give.
      window.location.href = "/admin";
    } catch {
      setError("Não foi possível iniciar sessão. Tente novamente.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Shield className="w-5 h-5 text-amber-500" strokeWidth={2.5} />
          <span className="font-mono font-bold uppercase tracking-wider text-lg text-white">
            FieldReady Admin
          </span>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded p-6">
          <h1 className="text-base font-semibold text-white">Acesso de administrador</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Área reservada à operação da plataforma — não é o login de nenhuma empresa cliente.
          </p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-3">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-zinc-400 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                placeholder="admin@fieldready.pt"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1">
                Palavra-passe
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded bg-amber-600 text-white text-sm font-medium py-2.5 hover:bg-amber-700 disabled:bg-zinc-700 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "A entrar…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
