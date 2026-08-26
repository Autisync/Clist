"use client";

/*
 * Create technician (rpc_technician_create) + pair/revoke a device
 * (POST /technicians/:id/pair, POST /technicians/devices/:id/revoke) —
 * technician-auth migration, 08-supabase-native-migration.md §2. See
 * page.tsx's own comment for why creation is a Supabase RPC but pairing/
 * revocation are still Fastify routes (both need the service_role Admin
 * API — apiFetch already attaches this office session's real Supabase
 * bearer token automatically now, apps/web/src/lib/api.ts's own fix for
 * exactly this class of still-Fastify route).
 *
 * Pairing shows the device id + PIN exactly once, same "transmit these to
 * the technician, there is no way to see them again" convention the old
 * Phase 1 version already used — still true here: the PIN is never stored
 * anywhere after this response (it becomes the device's Supabase Auth
 * password, which nothing in this app ever reads back).
 */

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Smartphone, Radio, Ban } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { Pill } from "../../_components/pill";

type Technician = { id: string; full_name: string; phone: string | null; active: boolean };
type Device = {
  id: string;
  user_id: string;
  device_label: string;
  paired_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
};

export function TechniciansClient({
  initialTechnicians,
  initialDevices,
}: {
  initialTechnicians: Technician[];
  initialDevices: Device[];
}) {
  const [technicians, setTechnicians] = useState(initialTechnicians);
  const [devices, setDevices] = useState(initialDevices);

  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [pairingFor, setPairingFor] = useState<string | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("");
  const [pin, setPin] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairResult, setPairResult] = useState<{ technicianId: string; deviceId: string; pin: string } | null>(null);

  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function createTechnician(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await supabase.rpc("rpc_technician_create", {
        p_full_name: newName.trim(),
        p_phone: newPhone.trim() || null,
      });
      if (error) throw error;
      if (data?.kind !== "ok") throw new Error(data?.kind ?? "unknown_error");
      setTechnicians((prev) =>
        [...prev, { id: data.id, full_name: data.full_name, phone: newPhone.trim() || null, active: true }].sort((a, b) =>
          a.full_name.localeCompare(b.full_name)
        )
      );
      setNewName("");
      setNewPhone("");
    } catch {
      setCreateError("Não foi possível criar o técnico. Tente novamente.");
    } finally {
      setCreating(false);
    }
  }

  async function pairDevice(technicianId: string) {
    if (!deviceLabel.trim() || !/^\d{4}$/.test(pin)) return;
    setPairing(true);
    setPairError(null);
    try {
      const res = await apiFetch<{ device_id: string }>(`/technicians/${technicianId}/pair`, {
        method: "POST",
        body: JSON.stringify({ device_label: deviceLabel.trim(), pin }),
      });
      setPairResult({ technicianId, deviceId: res.device_id, pin });
      setDevices((prev) => [
        { id: res.device_id, user_id: technicianId, device_label: deviceLabel.trim(), paired_at: new Date().toISOString(), revoked_at: null, last_seen_at: null },
        ...prev,
      ]);
      setPairingFor(null);
      setDeviceLabel("");
      setPin("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setPairError(
          "O Supabase está a rejeitar este PIN pelo comprimento mínimo de palavra-passe configurado — é preciso reduzi-lo para 4 nas definições do projeto."
        );
      } else {
        setPairError("Não foi possível emparelhar o dispositivo. Tente novamente.");
      }
    } finally {
      setPairing(false);
    }
  }

  async function revokeDevice(deviceId: string) {
    setRevokingId(deviceId);
    try {
      await apiFetch(`/technicians/devices/${deviceId}/revoke`, { method: "POST" });
      setDevices((prev) =>
        prev.map((d) => (d.id === deviceId ? { ...d, revoked_at: new Date().toISOString() } : d))
      );
    } catch {
      // Best-effort UI refresh only — a failed revoke leaves the device
      // shown as still active, which is the safe (not falsely-reassuring)
      // failure mode; the office user can just try again.
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="mt-5 space-y-5">
      <form onSubmit={createTechnician} className="bg-white border border-zinc-200 rounded p-4 space-y-3">
        <h2 className="text-sm font-semibold text-zinc-900">Novo técnico</h2>
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            required
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nome do técnico"
            className="flex-1 min-w-[10rem] rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
          <input
            type="text"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
            placeholder="Telemóvel (opcional)"
            className="w-40 rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
          />
          <button
            type="submit"
            disabled={creating || !newName.trim()}
            className="rounded bg-zinc-900 text-white text-sm font-medium px-4 py-2 hover:bg-zinc-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
          >
            {creating ? "A criar…" : "Criar técnico"}
          </button>
        </div>
        {createError && (
          <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{createError}</span>
          </div>
        )}
      </form>

      <div className="space-y-3">
        {technicians.length === 0 && (
          <div className="bg-white rounded border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
            Ainda não existem técnicos.
          </div>
        )}

        {technicians.map((tech) => {
          const techDevices = devices.filter((d) => d.user_id === tech.id);
          return (
            <div key={tech.id} className="bg-white border border-zinc-200 rounded p-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-sm font-medium text-zinc-900">{tech.full_name}</div>
                  {tech.phone && <div className="text-xs text-zinc-500">{tech.phone}</div>}
                </div>
                <button
                  onClick={() => {
                    setPairingFor(pairingFor === tech.id ? null : tech.id);
                    setPairError(null);
                    setPairResult(null);
                  }}
                  className="text-xs font-medium text-cyan-700 hover:text-cyan-800 flex items-center gap-1"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  Emparelhar dispositivo
                </button>
              </div>

              {techDevices.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {techDevices.map((d) => (
                    <li key={d.id} className="flex items-center justify-between gap-2 text-xs">
                      <div className="flex items-center gap-2 text-zinc-600">
                        <Radio className="w-3.5 h-3.5 text-zinc-400" />
                        {d.device_label}
                        {d.revoked_at ? (
                          <Pill tone="zinc">Revogado</Pill>
                        ) : (
                          <Pill tone="green">Ativo</Pill>
                        )}
                      </div>
                      {!d.revoked_at && (
                        <button
                          onClick={() => revokeDevice(d.id)}
                          disabled={revokingId === d.id}
                          className="flex items-center gap-1 text-red-700 hover:text-red-800 disabled:opacity-50"
                        >
                          <Ban className="w-3.5 h-3.5" />
                          {revokingId === d.id ? "A revogar…" : "Revogar"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {pairingFor === tech.id && (
                <div className="mt-3 pt-3 border-t border-zinc-100 space-y-2">
                  <div className="flex gap-2 flex-wrap">
                    <input
                      type="text"
                      value={deviceLabel}
                      onChange={(e) => setDeviceLabel(e.target.value)}
                      placeholder="Etiqueta do dispositivo"
                      className="flex-1 min-w-[8rem] rounded border border-zinc-300 px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="\d{4}"
                      maxLength={4}
                      value={pin}
                      onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                      placeholder="PIN"
                      className="w-24 rounded border border-zinc-300 px-3 py-2 text-sm font-mono tabular-nums text-zinc-900 focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:border-cyan-600"
                    />
                    <button
                      onClick={() => pairDevice(tech.id)}
                      disabled={pairing || !deviceLabel.trim() || pin.length !== 4}
                      className="rounded bg-cyan-600 text-white text-sm font-medium px-3 py-2 hover:bg-cyan-700 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors"
                    >
                      {pairing ? "A emparelhar…" : "Confirmar"}
                    </button>
                  </div>
                  {pairError && (
                    <div className="flex items-start gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>{pairError}</span>
                    </div>
                  )}
                </div>
              )}

              {pairResult && pairResult.technicianId === tech.id && (
                <div className="mt-3 rounded border border-green-300 bg-green-50 p-3">
                  <div className="flex items-center gap-2 text-green-800 font-medium text-xs">
                    <CheckCircle2 className="w-4 h-4" />
                    Dispositivo emparelhado
                  </div>
                  <p className="text-xs text-green-900 mt-1.5">
                    Transmita estes dois valores ao técnico — não é possível consultá-los de novo.
                  </p>
                  <dl className="mt-2 space-y-1">
                    <div>
                      <dt className="text-xs text-green-700">ID do dispositivo</dt>
                      <dd className="font-mono text-xs text-green-950 break-all">{pairResult.deviceId}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-green-700">PIN</dt>
                      <dd className="font-mono text-base tabular-nums text-green-950">{pairResult.pin}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
