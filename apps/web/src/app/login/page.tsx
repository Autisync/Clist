"use client";

/*
 * Office login — outside both /office and /field route groups (this page
 * has no shell/nav; it's what an unauthenticated visitor lands on). Plain
 * centered card, zinc/cyan palette per the project's visual identity — the
 * prototype had no login screen to port (it assumed an already-logged-in
 * state), so this is new, functional UI, not a port.
 *
 * middleware.ts redirects unauthenticated /office/* requests here (with
 * ?next=<original path>) — honoring `next` on success is a small, low-risk
 * addition on top of the literal "redirect to /office/jobs" instruction so
 * a bookmarked deep link actually lands where the user meant to go.
 */

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Radio, AlertTriangle } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = searchParams.get("next");
  const redirectTo = next && next.startsWith("/office") ? next : "/office/jobs";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<{ ok: boolean; role: string }>("/auth/office/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      router.push(redirectTo);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("Credenciais inválidas.");
      } else {
        setError("Não foi possível iniciar sessão. Tente novamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Radio className="w-5 h-5 text-cyan-600" strokeWidth={2.5} />
          <span className="font-mono font-bold uppercase tracking-wider text-lg text-zinc-900">
            FieldReady
          </span>
        </div>

        <div className="bg-white border border-zinc-200 rounded p-6">
          <h1 className="text-base font-semibold text-zinc-900">Acesso ao escritório</h1>
          <p className="text-sm text-zinc-500 mt-1">Entre com o seu email e palavra-passe.</p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-3">
            <div>
              <label htmlFor="email" className="block text-xs font-medium text-zinc-600 mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                placeholder="voce@empresa.pt"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs font-medium text-zinc-600 mb-1">
                Palavra-passe
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                placeholder="••••••••"
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
              disabled={submitting}
              className="w-full rounded bg-zinc-900 text-white text-sm font-medium py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
            >
              {submitting ? "A entrar…" : "Entrar"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
