"use client";

/*
 * Technician PIN entry — ported as closely as possible from
 * fieldready-prototype.jsx's "pin" screen (dark zinc-900, Radio icon,
 * 4-dot indicator, numeric keypad, auto-submit at 4 digits) — see
 * CLAUDE.md: "treat its interaction design, the phone flow especially, as
 * settled." The prototype's version just faked success after 4 digits;
 * here it's a real POST to /auth/technician/login, with the prototype's
 * existing red-tinted error convention (bg-red-50/border-red-300/
 * text-red-800 elsewhere in the app) plus a shake, on failure.
 *
 * Needs a deviceId that isn't part of the prototype's mock state at all
 * (pairing wasn't modeled there). Phase 1 has no per-technician account
 * flow beyond "office pairs a device and relays the device_id" (see
 * /office/technicians), so this stores/reads deviceId from localStorage,
 * with a minimal one-time device-id paste screen when none is stored yet.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, XCircle } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

const DEVICE_ID_KEY = "fr_device_id";
const KEYPAD: (number | string | null)[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, null, 0, "←"];

export default function FieldLoginPage() {
  const router = useRouter();

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
      await apiFetch<{ ok: boolean }>("/auth/technician/login", {
        method: "POST",
        body: JSON.stringify({ deviceId, pin: fullPin }),
      });
      router.push("/field/home");
      // Deliberately no `finally { setSubmitting(false) }` on the success
      // path — the keypad should stay locked while navigation happens
      // rather than flash re-enabled for a frame.
    } catch (err) {
      setError(true);
      setShake(true);
      setPin("");
      setSubmitting(false);
      setTimeout(() => setShake(false), 500);
      setTimeout(() => setError(false), 2000);
      if (!(err instanceof ApiError)) {
        // Network/unexpected error — still shows the same affordance;
        // nothing further to do here.
      }
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
