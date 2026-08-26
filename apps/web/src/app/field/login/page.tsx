"use client";

/*
 * Technician PIN entry — ported as closely as possible from
 * fieldready-prototype.jsx's "pin" screen (dark zinc-900, Radio icon,
 * 4-dot indicator, numeric keypad, auto-submit at 4 digits) — see
 * CLAUDE.md: "treat its interaction design, the phone flow especially, as
 * settled." The prototype's version just faked success after 4 digits.
 *
 * Technician-auth migration (08-supabase-native-migration.md §2): this now
 * signs in via real Supabase Auth (supabase.auth.signInWithPassword)
 * instead of POSTing to the classic system's /auth/technician/login —
 * each paired device IS its own Supabase Auth user (routes/technicians.ts's
 * pairing endpoint), synthetic email `${deviceId}@device.fieldready.internal`,
 * password = the real 4-digit PIN. The UX is unchanged on purpose: the
 * phone still only ever shows deviceId + a 4-digit keypad — the synthetic
 * email is an implementation detail derived here, never shown to the
 * technician, exactly as the design doc's own plan says it should be.
 *
 * Needs a deviceId that isn't part of the prototype's mock state at all
 * (pairing wasn't modeled there). Still no per-technician account flow
 * beyond "office pairs a device and relays the device_id" (see
 * /office/technicians), so this stores/reads deviceId from localStorage,
 * with a minimal one-time device-id paste screen when none is stored yet.
 */

import { useEffect, useState } from "react";
import { Radio, XCircle } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

const DEVICE_ID_KEY = "fr_device_id";
const DEVICE_EMAIL_DOMAIN = "device.fieldready.internal";
const KEYPAD: (number | string | null)[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "←"];

export default function FieldLoginPage() {
  // null = "not checked yet" (avoids a flash of the setup screen before
  // localStorage has been read on mount).
  const [deviceId, setDeviceId] = useState<string | null | undefined>(undefined);
  const [deviceIdInput, setDeviceIdInput] = useState("");

  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    setDeviceId(localStorage.getItem(DEVICE_ID_KEY));
  }, []);

  function saveDeviceId(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = deviceIdInput.trim();
    if (!trimmed) return;
    localStorage.setItem(DEVICE_ID_KEY, trimmed);
    setDeviceId(trimmed);
  }

  async function submitPin(fullPin: string) {
    if (!deviceId) return;
    setSubmitting(true);
    try {
      const supabase = createSupabaseBrowserClient();
      const { error } = await supabase.auth.signInWithPassword({
        email: `${deviceId}@${DEVICE_EMAIL_DOMAIN}`,
        password: fullPin,
      });
      if (error) throw error;
      // Full navigation, not router.push — the same reasoning office
      // login's own comment gives: middleware.ts needs to re-evaluate with
      // the just-set Supabase session cookie actually present, which a
      // client-side route transition wouldn't force.
      window.location.href = "/field/home";
      // Deliberately no `finally { setSubmitting(false) }` on the success
      // path — the keypad should stay locked while navigation happens
      // rather than flash re-enabled for a frame.
    } catch {
      // Wrong PIN and "device revoked" (banned — routes/technicians.ts's
      // revoke handler) both surface as the same Supabase Auth sign-in
      // failure — indistinguishable from here by design, same as the
      // classic system's own invalid_device/invalid_pin both just meaning
      // "PIN incorrect" to the technician; there's nothing actionable a
      // revoked device's holder should be able to do differently anyway.
      setError(true);
      setShake(true);
      setPin("");
      setSubmitting(false);
      setTimeout(() => setShake(false), 500);
      setTimeout(() => setError(false), 2000);
    }
  }

  function press(n: number | string | null) {
    if (n === null || submitting) return;
    if (n === "←") {
      setPin((p) => p.slice(0, -1));
      return;
    }
    const next = pin + String(n);
    setPin(next);
    if (next.length === 4) {
      submitPin(next);
    }
  }

  // Still resolving localStorage — render nothing rather than flash the
  // wrong screen.
  if (deviceId === undefined) {
    return <div className="h-full bg-zinc-900" />;
  }

  if (deviceId === null) {
    return (
      <div className="flex flex-col h-full bg-zinc-900 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <Radio className="w-10 h-10 text-cyan-400" />
          <div className="mt-3 text-lg font-semibold">Configuração do dispositivo</div>
          <p className="text-sm text-zinc-400 mt-1 max-w-xs">
            Peça ao escritório o ID do dispositivo emparelhado e cole-o abaixo. Só precisa
            de fazer isto uma vez neste telemóvel.
          </p>
        </div>
        <form onSubmit={saveDeviceId} className="space-y-3">
          <input
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={deviceIdInput}
            onChange={(e) => setDeviceIdInput(e.target.value)}
            placeholder="ID do dispositivo"
            className="w-full rounded-xl border-2 border-zinc-700 bg-zinc-800 px-4 py-4 text-base text-white placeholder-zinc-500 focus:outline-none focus:border-cyan-400 font-mono"
          />
          <button
            type="submit"
            disabled={!deviceIdInput.trim()}
            className="w-full py-4 px-4 rounded-xl text-lg font-semibold bg-zinc-100 text-zinc-900 active:bg-white disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            Continuar
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-900 text-white p-6">
      <div className="flex-1 flex flex-col items-center justify-center">
        <Radio className="w-10 h-10 text-cyan-400" />
        <div className="mt-3 text-lg font-semibold">Sessão do técnico</div>
        <div className="text-sm text-zinc-400">Código de 4 dígitos</div>

        <div
          className={`flex gap-3 mt-5 ${shake ? "animate-fr-shake" : ""}`}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full ${
                error ? "bg-red-500" : i < pin.length ? "bg-cyan-400" : "bg-zinc-700"
              }`}
            />
          ))}
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-1.5 text-red-400 text-sm font-medium">
            <XCircle className="w-4 h-4" />
            PIN incorreto
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {KEYPAD.map((n, i) => (
          <button
            key={i}
            disabled={n === null || submitting}
            onClick={() => press(n)}
            className={`py-4 rounded-xl text-2xl font-medium ${
              n === null ? "" : "bg-zinc-800 active:bg-zinc-700 disabled:opacity-50"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4">
        <p className="text-xs text-zinc-500">Sem palavra-passe. Telemóvel associado ao técnico.</p>
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem(DEVICE_ID_KEY);
            setDeviceId(null);
            setDeviceIdInput("");
            setPin("");
          }}
          className="text-xs text-zinc-500 underline shrink-0 ml-2"
        >
          Mudar dispositivo
        </button>
      </div>
    </div>
  );
}
