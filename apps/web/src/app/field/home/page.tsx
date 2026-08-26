"use client";

/*
 * Technician home — today's assigned job. Ports fieldready-prototype.jsx's
 * "home" screen (dark header with date/greeting, job card, "Ver o que
 * levar" / "Abrir mapa" buttons) — CLAUDE.md: "treat its interaction
 * design as settled."
 *
 * Technician-auth migration (08-supabase-native-migration.md §2): reads now
 * go straight to Supabase instead of GET /api/sync/bootstrap + GET
 * /api/jobs/:id + GET /api/clients (the classic system's own three-call
 * shape this page used to need, per its own now-superseded comment) —
 * `job` scoped by `assigned_to = <own app_user id> and status in
 * (dispatched, in_progress, testing)`, same filter and ordering
 * apps/api/src/routes/sync.ts's bootstrap handler used, ordered by
 * created_at desc, taking the first result. fn_current_app_user_id() is
 * directly callable as its own RPC (confirmed this session — no explicit
 * grant/revoke on it in schema.sql, so Postgres's default PUBLIC execute
 * grant on a new function already exposes it) — this is how a technician
 * session resolves "which app_user am I" without a dedicated whoami route,
 * closing the gap the classic system's own /office/technicians comment
 * used to name.
 *
 * Still no source for the technician's first name (fn_current_app_user_id
 * gives an id, not a name, and reading it back would be a second round
 * trip for cosmetic value only) — greeting drops the name rather than fake
 * one, same deviation the classic version already documented.
 *
 * Zero jobs -> plain "Sem trabalhos atribuídos hoje" empty state, unchanged.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Package, Navigation, Radio } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { BigButton } from "@/components/field/BigButton";

type Job = {
  id: string;
  code: string;
  title: string;
  address: string | null;
  client_id: string;
  scheduled_at: string | null;
};

type Client = { id: string; name: string };

type LoadState =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "error"; message: string }
  | { kind: "ready"; job: Job; clientName: string | null };

function formatDate(): string {
  const s = new Date().toLocaleDateString("pt-PT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(iso: string | null): string {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

export default function FieldHomePage() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const supabase = createSupabaseBrowserClient();

        // Own app_user id, resolved server-side through technician_device
        // (fn_current_app_user_id(), schema.sql) — null here means either
        // no session at all, or a REVOKED device with a still-technically-
        // valid Supabase access token (routes/technicians.ts's revoke
        // handler; the bridge-auth-proof.mjs/technician-pairing-proof.mjs
        // scenario, now reachable from the phone UI too). Either way, the
        // correct move is the same: this device is not usable, sign out
        // whatever session it thinks it has and send it back to the PIN
        // screen — middleware.ts's own getUser() check alone would NOT
        // catch the revoked-device case (Supabase itself has no idea this
        // app revoked it), so this is the one place that has to.
        const { data: myUserId, error: whoamiError } = await supabase.rpc("fn_current_app_user_id");
        if (cancelled) return;
        if (whoamiError || !myUserId) {
          await supabase.auth.signOut();
          router.push("/field/login");
          return;
        }

        const { data: jobs, error: jobError } = await supabase
          .from("job")
          .select("id, code, title, address, client_id, scheduled_at")
          .eq("assigned_to", myUserId)
          .in("status", ["dispatched", "in_progress", "testing"])
          .order("created_at", { ascending: false })
          .limit(1);
        if (cancelled) return;
        if (jobError) throw jobError;

        const job = jobs?.[0] as Job | undefined;
        if (!job) {
          setState({ kind: "empty" });
          return;
        }

        const { data: client, error: clientError } = await supabase
          .from("client")
          .select("id, name")
          .eq("id", job.client_id)
          .maybeSingle<Client>();
        if (cancelled) return;
        if (clientError) throw clientError;

        setState({ kind: "ready", job, clientName: client?.name ?? null });
      } catch {
        if (cancelled) return;
        setState({ kind: "error", message: "Não foi possível carregar o trabalho de hoje." });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state.kind === "loading") {
    return <div className="h-full bg-zinc-900" />;
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-col h-full bg-zinc-900 text-white p-6 items-center justify-center text-center gap-2">
        <Radio className="w-8 h-8 text-cyan-400" />
        <p className="text-sm text-zinc-300">{state.message}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-zinc-50">
      <div className="bg-zinc-900 text-white px-5 py-4 shrink-0">
        <div className="text-xs text-zinc-400 font-mono">{formatDate()}</div>
        <div className="text-xl font-semibold">Bom dia</div>
      </div>

      <div className="p-4 space-y-3 flex-1 overflow-auto">
        {state.kind === "empty" && (
          <div className="flex flex-col items-center justify-center text-center gap-2 py-16">
            <Package className="w-10 h-10 text-zinc-300" />
            <p className="text-base font-medium text-zinc-600">Sem trabalhos atribuídos hoje</p>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <div className="text-xs font-semibold text-zinc-500 uppercase pt-2">Hoje</div>
            <div className="bg-white rounded-xl border-2 border-zinc-200 p-4">
              <div className="text-2xl font-bold font-mono tabular-nums">
                {formatTime(state.job.scheduled_at)}
              </div>
              <div className="text-lg font-semibold mt-1 leading-tight">{state.job.title}</div>
              {state.clientName && (
                <div className="text-base text-zinc-600 mt-1">{state.clientName}</div>
              )}
              {state.job.address && (
                <div className="text-base text-zinc-600">{state.job.address}</div>
              )}

              <div className="mt-4 space-y-2">
                <BigButton
                  icon={Package}
                  onClick={() => router.push(`/field/jobs/${state.job.id}/prep`)}
                >
                  Ver o que levar
                </BigButton>
                <BigButton
                  tone="ghost"
                  icon={Navigation}
                  disabled={!state.job.address}
                  onClick={() => {
                    if (!state.job.address) return;
                    window.open(
                      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                        state.job.address
                      )}`,
                      "_blank",
                      "noopener,noreferrer"
                    );
                  }}
                >
                  Abrir mapa
                </BigButton>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
