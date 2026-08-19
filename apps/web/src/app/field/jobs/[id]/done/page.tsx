"use client";

/*
 * "Terminado" screen — ports fieldready-prototype.jsx's "done" screen
 * (fieldready-prototype.jsx:1690-1704): full-bleed green success state,
 * "Voltar ao início" back to /field/home. CLAUDE.md: "treat its
 * interaction design as settled."
 *
 * On mount, enqueues the real closeout.submit mutation
 * (src/lib/offline-queue.ts) using whatever /voice handed off via
 * sessionStorage (../_lib/closeout.ts) — same cross-route-boundary pattern
 * /prep -> /prep-result already uses. If there's nothing to read (direct
 * navigation, cleared storage, private browsing), this sends the
 * technician back to /voice rather than silently submitting an empty
 * close-out.
 *
 * This page's payload is exactly {first_time_fix, technician_note_transcript,
 * technician_voice_note_file?} — there is NO rework_cause field anywhere
 * here, matching JobCloseoutTechnicianRequest (packages/core/src/closeout.ts)
 * and this stage's own non-negotiable: rework_cause is office-only
 * taxonomy, assigned later from the office UI, never technician-set.
 *
 * The prototype's "5h 30 · relatório enviado" line hardcodes an elapsed
 * time this build has no source for (no server-side timer-start endpoint —
 * same reasoning /site's page header already documents), so that specific
 * number is dropped; everything else in the success copy is kept.
 */

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { enqueueMutation } from "@/lib/offline-queue";
import { BigButton } from "@/components/field/BigButton";
import { closeoutStorageKey, type CloseoutHandoff } from "../_lib/closeout";

type State = "loading" | "missing-data" | "submitted";

export default function DonePage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [state, setState] = useState<State>("loading");
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current) return; // guards React dev double-invoke
    submittedRef.current = true;

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(closeoutStorageKey(jobId));
      if (raw) sessionStorage.removeItem(closeoutStorageKey(jobId));
    } catch {
      raw = null;
    }

    if (!raw) {
      setState("missing-data");
      return;
    }

    try {
      const payload: CloseoutHandoff = JSON.parse(raw);
      // Synchronous/local (IndexedDB write only) — never blocks rendering
      // the success screen, see offline-queue.ts's own contract.
      void enqueueMutation({
        type: "closeout.submit",
        job_id: jobId,
        payload: {
          first_time_fix: payload.first_time_fix,
          technician_note_transcript: payload.technician_note_transcript,
          technician_voice_note_file: payload.technician_voice_note_file,
        },
      });
      setState("submitted");
    } catch {
      setState("missing-data");
    }
  }, [jobId]);

  useEffect(() => {
    if (state === "missing-data") {
      router.replace(`/field/jobs/${jobId}/voice`);
    }
  }, [state, jobId, router]);

  if (state !== "submitted") {
    return <div className="h-full bg-white" />;
  }

  return (
    <div className="flex flex-col h-full bg-green-600 text-white p-6">
      <div className="flex-1 flex flex-col items-center justify-center text-center">
        <CheckCircle2 className="w-20 h-20" />
        <div className="mt-4 text-3xl font-bold">Terminado</div>
        <div className="mt-6 text-base text-green-100 px-4">
          O escritório recebeu as medições, as fotos e a sua nota.
        </div>
      </div>
      <BigButton tone="ghost" onClick={() => router.push("/field/home")}>
        Voltar ao início
      </BigButton>
    </div>
  );
}
