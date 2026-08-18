"use client";

/*
 * Device pairing — not in the mock prototype (which assumed pairing had
 * already happened before the phone flow starts). POST /auth/technician/pair
 * expects {inviteToken, deviceLabel, pin}; per the route's Phase 1
 * simplification (apps/api/src/routes/auth.ts), inviteToken must actually
 * BE the calling office user's own app_user.id, not a generic invite code.
 *
 * There is no route that echoes the logged-in office user's id back to the
 * client (no GET /auth/whoami, and nothing else in the API surface returns
 * req.auth as part of its response) — checked apps/api/src/routes/*.ts.
 * A Server Action can't manufacture that value either: it would still need
 * to either call a nonexistent whoami route or decode the fr_session JWT
 * itself, which means duplicating apps/api's SESSION_JWT_SECRET into the
 * web app — a real secret-sharing footgun for a Phase 1 convenience. So
 * per the task's own fallback: the office user pastes their own id in
 * manually, clearly labeled as a temporary Phase 1 limitation. See
 * deviations in the stage report.
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Smartphone } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

type PairResult = { device_id: string };

export default function TechniciansPage() {
  const [inviteToken, setInviteToken] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PairResult & { pin: string }) | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<PairResult>("/auth/technician/pair", {
        method: "POST",
        body: JSON.stringify({ inviteToken: inviteToken.trim(), deviceLabel, pin }),
      });
      setResult({ ...res, pin });
      setDeviceLabel("");
      setPin("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError("ID de utilizador inválido — confirme que colou o seu próprio ID de utilizador.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("Dados inválidos — o PIN tem de ter 4 dígitos e a etiqueta não pode estar vazia.");
      } else {
        setError("Não foi possível emparelhar o dispositivo. Tente novamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-xl">
      <div className="flex items-center gap-2">
        <Smartphone className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Emparelhar dispositivo</h1>
      </div>
      <p className="text-sm text-zinc-500 mt-1">
        Associe o telemóvel de um técnico a esta empresa gerando um ID de dispositivo e um PIN
        de 4 dígitos, que depois transmite ao técnico.
      </p>

      <div className="mt-4 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        <div>
          <span className="font-medium">Limitação temporária da Fase 1:</span> esta rota
          identifica quem convida através do <span className="font-mono">inviteToken</span>, que
          hoje tem de ser o seu próprio ID de utilizador (<span className="font-mono">app_user.id</span>).
          Ainda não existe nenhuma forma de a app ir buscar esse valor sozinha — cole-o abaixo
          manualmente. Isto é uma simplificação da Fase 1, não o desenho final.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-5 space-y-3 bg-white border border-zinc-200 rounded p-5">
        <div>
          <label htmlFor="inviteToken" className="block text-xs font-medium text-zinc-600 mb-1">
            O seu ID de utilizador (temporário)
          </label>
          <input
            id="inviteToken"
            type="text"
            required
            value={inviteToken}
            onChange={(e) => setInviteToken(e.target.value)}
            placeholder="app_user.id (UUID)"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm font-mono text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
        </div>

        <div>
          <label htmlFor="deviceLabel" className="block text-xs font-medium text-zinc-600 mb-1">
            Etiqueta do dispositivo
          </label>
          <input
            id="deviceLabel"
            type="text"
            required
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            placeholder="Telemóvel do Rui"
            className="w-full rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
        </div>

        <div>
          <label htmlFor="pin" className="block text-xs font-medium text-zinc-600 mb-1">
            PIN de 4 dígitos
          </label>
          <input
            id="pin"
            type="text"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength={4}
            required
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="1234"
            className="w-32 rounded border border-zinc-300 px-3 py-2 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
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
          disabled={submitting || pin.length !== 4}
          className="rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2.5 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? "A emparelhar…" : "Emparelhar dispositivo"}
        </button>
      </form>

      {result && (
        <div className="mt-4 rounded border border-green-300 bg-green-50 p-5">
          <div className="flex items-center gap-2 text-green-800 font-medium text-sm">
            <CheckCircle2 className="w-4 h-4" />
            Dispositivo emparelhado
          </div>
          <p className="text-sm text-green-900 mt-2">
            Transmita estes dois valores ao técnico — não existe forma de os consultar de
            novo nesta fase da app.
          </p>
          <dl className="mt-3 space-y-2">
            <div>
              <dt className="text-xs text-green-700">ID do dispositivo</dt>
              <dd className="font-mono text-sm tabular-nums text-green-950 break-all">
                {result.device_id}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-green-700">PIN</dt>
              <dd className="font-mono text-lg tabular-nums text-green-950">{result.pin}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
