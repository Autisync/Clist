"use client";

/*
 * Technician home — today's assigned job. Ports fieldready-prototype.jsx's
 * "home" screen (dark header with date/greeting, job card, "Ver o que
 * levar" / "Abrir mapa" buttons) — CLAUDE.md: "treat its interaction
 * design as settled."
 *
 * Real data instead of the prototype's hardcoded JOB-2041:
 *   - GET /api/sync/bootstrap returns the technician's own assigned
 *     dispatched/in_progress/testing jobs (already scoped server-side to
 *     the session's user_id) — take the first one, per this stage's task.
 *   - Bootstrap's job rows only carry id + snapshots + checklist item
 *     id/status (apps/api/src/routes/sync.ts), not title/address/
 *     scheduled_at/client_id, so a follow-up GET /api/jobs/:id fills those
 *     in — same "no single route has everything" situation the office
 *     job-detail page already documents and solves the same way.
 *   - There's no GET /clients/:id (only the tenant-scoped list, checked
 *     apps/api/src/routes/clients.ts) — same pattern as the office pages:
 *     fetch GET /api/clients and find by id client-side.
 *
 * No GET /auth/whoami exists (see office/technicians/page.tsx's own note
 * on this gap), so there's no source for the technician's first name the
 * prototype's "Bom dia, Rui" hardcoded — greeting drops the name rather
 * than fake one. Documented as a deviation.
 *
 * Zero jobs -> plain "Sem trabalhos atribuídos hoje" empty state, not a
 * broken card (this stage's explicit instruction).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Package, Navigation, Radio } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { BigButton } from "@/components/field/BigButton";

type BootstrapJob = {
  id: string;
  checklist_items: { id: string; status: string }[];
};

type Job = {
  id: string;
  code: string;
  title: string;
  address: string | null;
  client_id: string;
  scheduled_at: string | null;
};

type Client = { id: string; name: string; address: string | null };

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
        const bootstrap = await apiFetch<{ jobs: BootstrapJob[] }>("/sync/bootstrap");
        if (cancelled) return;

        const first = bootstrap.jobs[0];
        if (!first) {
          setState({ kind: "empty" });
          return;
        }

        const [job, { clients }] = await Promise.all([
          apiFetch<Job>(`/jobs/${first.id}`),
          apiFetch<{ clients: Client[] }>("/clients"),
        ]);
        if (cancelled) return;

        const client = clients.find((c) => c.id === job.client_id) ?? null;
        setState({ kind: "ready", job, clientName: client?.name ?? null });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.push("/field/login");
          return;
        }
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
