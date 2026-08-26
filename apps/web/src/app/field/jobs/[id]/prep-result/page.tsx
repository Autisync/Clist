"use client";

/*
 * Readiness walkthrough result — ports fieldready-prototype.jsx's
 * "prepresult" screen: full-bleed green "Pode arrancar" state when nothing
 * is missing, full-bleed red "Faltam N" state with the missing-items list
 * otherwise, "Cheguei ao local" -> /field/jobs/[id]/site either way.
 * CLAUDE.md: "treat its interaction design as settled."
 *
 * Reads the answers /prep recorded via sessionStorage (see
 * ../_lib/prep.ts — this stage doesn't persist answers to the API yet).
 * If nothing is there (direct navigation, cleared storage, private
 * browsing), send the technician back to /prep rather than render a
 * meaningless empty/green screen.
 *
 * The "Passar por" supplier-pickup card (07-phase4-cost-intelligence.md
 * §4, GET /jobs/:id/pickup-plan) is restored here now that the sourcing
 * API exists: when there are missing materials, fetch the job's pickup
 * plan and show its top recommendation — supplier name, address, open/
 * closed state, distance, "Levar-me lá" — matching
 * fieldready-prototype.jsx's prepresult screen (~line 1534) exactly. If no
 * supplier has a price on record for any missing item, the plan comes back
 * empty and the card says so honestly instead of showing nothing.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle, XCircle, Navigation, MapPin } from "lucide-react";
import { BigButton } from "@/components/field/BigButton";
import { prepStorageKey, type PrepAnswerItem } from "../_lib/prep";

type PickupPlanEntry = {
  supplier: {
    id: string;
    name: string;
    address: string | null;
    distance_km: number | string | null;
  };
  state: { open: boolean; text: string };
  items: { checklist_item_id: string; label: string; item_id: string; qty: number; price: number }[];
  total: number;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "missing-data" }
  | { kind: "ready"; missing: PrepAnswerItem[] };

export default function PrepResultPage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [pickupPlan, setPickupPlan] = useState<PickupPlanEntry[] | null>(null);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(prepStorageKey(jobId));
    } catch {
      raw = null;
    }

    if (!raw) {
      setState({ kind: "missing-data" });
      return;
    }

    try {
      const items: PrepAnswerItem[] = JSON.parse(raw);
      setState({ kind: "ready", missing: items.filter((c) => c.answer === "no") });
    } catch {
      setState({ kind: "missing-data" });
    }
  }, [jobId]);

  useEffect(() => {
    if (state.kind === "missing-data") {
      router.replace(`/field/jobs/${jobId}/prep`);
    }
  }, [state.kind, jobId, router]);

  // Supplier pickup plan — NOT ported in the technician-auth migration.
  // GET /jobs/:id/pickup-plan (07-phase4-cost-intelligence.md §4) is the
  // classic Fastify system's own route, reading `jobId` against the
  // CLASSIC schema's own job table — a completely different id space from
  // the Supabase-native `public.job` id this page now has (technician-auth
  // migration, 08-supabase-native-migration.md §2), so it would 404 for
  // every real call from here, always. Porting the full multi-supplier
  // coverage/open-now/price ranking algorithm (domain/sourcing.ts's
  // pickupPlan(), a real algorithm, not a simple filter) to a Supabase RPC
  // is real, separate follow-up work, deliberately out of scope for
  // getting the core technician loop (login/checklist/execution/tests/
  // closeout) working end to end — apps/web/src/lib/dashboard.ts's
  // sourcingOptionsFor() ported the simpler per-item case for the office
  // dashboard; the multi-item pickup-plan optimization itself is still
  // only proven against the classic system's own test fixtures
  // (apps/api/test/phase4-proof.mjs). Left disabled rather than calling a
  // route guaranteed to fail — pickupPlan starts and stays [], which the
  // render below already treats as "no suggestions" (a real, pre-existing
  // state, not a new failure mode this introduces).
  useEffect(() => {
    setPickupPlan([]);
  }, [state]);

  if (state.kind === "loading" || state.kind === "missing-data") {
    return <div className="h-full bg-white" />;
  }

  const { missing } = state;
  const best = pickupPlan && pickupPlan.length > 0 ? pickupPlan[0] : null;

  if (missing.length === 0) {
    return (
      <div className="flex flex-col h-full bg-green-600 text-white p-6">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <CheckCircle2 className="w-20 h-20" />
          <div className="mt-4 text-3xl font-bold">Pode arrancar</div>
          <div className="mt-2 text-lg text-green-100">Tem tudo o que precisa</div>
        </div>
        <BigButton tone="ghost" onClick={() => router.push(`/field/jobs/${jobId}/site`)}>
          Cheguei ao local
        </BigButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-red-600 text-white">
      <div className="p-6 text-center shrink-0">
        <AlertTriangle className="w-16 h-16 mx-auto" />
        <div className="mt-3 text-2xl font-bold font-mono tabular-nums">Faltam {missing.length}</div>
      </div>
      <div className="flex-1 bg-white rounded-t-3xl p-4 overflow-auto">
        <div className="space-y-2">
          {missing.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 p-3 rounded-xl bg-red-50 border-2 border-red-200"
            >
              <XCircle className="w-6 h-6 text-red-600 shrink-0" />
              <span className="text-base font-medium text-zinc-900">
                {m.qty}× {m.label}
              </span>
            </div>
          ))}
        </div>

        {best ? (
          <div className="mt-4 p-4 rounded-xl bg-cyan-50 border-2 border-cyan-300">
            <div className="text-sm font-semibold text-cyan-900 uppercase">Passar por</div>
            <div className="text-xl font-bold mt-1 leading-tight">
              {best.supplier.name.split("—")[0].trim()}
            </div>
            {best.supplier.address && (
              <div className="text-base text-zinc-700">{best.supplier.address.split(",")[0]}</div>
            )}
            <div className="mt-2 flex items-center gap-2 text-base flex-wrap">
              {best.state.open ? (
                <>
                  <CheckCircle2 className="w-5 h-5 text-green-700" />
                  <span className="text-green-800 font-semibold">{best.state.text}</span>
                </>
              ) : (
                <>
                  <XCircle className="w-5 h-5 text-red-700" />
                  <span className="text-red-800 font-semibold">{best.state.text}</span>
                </>
              )}
              {best.supplier.distance_km !== null && (
                <span className="text-zinc-500 flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {best.supplier.distance_km} km
                </span>
              )}
            </div>
            <div className="mt-3">
              <BigButton icon={Navigation}>Levar-me lá</BigButton>
            </div>
          </div>
        ) : pickupPlan !== null ? (
          <div className="mt-4 p-3 rounded-xl bg-zinc-50 border-2 border-zinc-200 text-sm text-zinc-500">
            Sem fornecedor com preço registado para os itens em falta.
          </div>
        ) : null}

        <div className="mt-4">
          <BigButton tone="ghost" onClick={() => router.push(`/field/jobs/${jobId}/site`)}>
            Cheguei ao local
          </BigButton>
        </div>
      </div>
    </div>
  );
}
