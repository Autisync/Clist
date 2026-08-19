"use client";

/*
 * "Como correu?" screen — ports fieldready-prototype.jsx's "voice" screen
 * (fieldready-prototype.jsx:1655-1688): a big mic button to record, a
 * manual-entry fallback that always works, "Fechar trabalho" through to
 * /done. CLAUDE.md: "treat its interaction design as settled" / "the
 * technician never classifies anything — his job is to report what
 * happened in his own words (voice-first); a human in the office assigns
 * taxonomy afterward."
 *
 * Recording: the real MediaRecorder API (getUserMedia({audio:true})),
 * producing a real audio blob — not the prototype's hardcoded fake
 * transcript. There is no speech-to-text service wired into this build (no
 * vendor has been evaluated for that, same posture as Phase 4's
 * not-yet-evaluated receipt OCR — see project brief §Phase 4), so the
 * recording is captured and uploaded as real audio evidence, but the
 * *text* transcript field the API actually requires
 * (technician_note_transcript, min length 1) is always typed by hand in the
 * textarea below — matching this stage's explicit instruction that manual
 * entry must always work and never be blocked, and never inventing an STT
 * result that didn't happen.
 *
 * Upload: apps/api/src/routes/jobs.ts has exactly one upload route,
 * POST /jobs/:id/photos (confirmed by reading the whole file — no separate
 * audio route exists). Per this stage's explicit instruction, the recorded
 * clip reuses that same route with phase="evidence" to obtain a file key
 * for technician_voice_note_file, rather than inventing a new backend
 * route. Flagged again in this task's returned `deviations`.
 *
 * first_time_fix: JobCloseoutTechnicianRequest (packages/core/src/closeout.ts)
 * requires a boolean first_time_fix, but neither the prototype's "voice"
 * nor "done" screen has any control for it (the prototype's only
 * "Resolvido à primeira visita?" field lives in the *office* job-detail
 * view, fieldready-prototype.jsx:1054 — a different screen entirely, office
 * not phone). Rather than inventing a whole new phone screen, this page
 * adds one small Sim/Não toggle, defaulting to Sim, immediately above
 * "Fechar trabalho" — flagged as a deviation from the prototype rather than
 * silently dropping a required field.
 *
 * The actual closeout.submit mutation is enqueued by /done on mount, not
 * here — this page's job is only to collect the data and hand it across
 * the real route boundary via sessionStorage, same pattern as /prep ->
 * /prep-result (../_lib/prep.ts).
 */

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Mic, Keyboard, CheckCircle2, XCircle } from "lucide-react";
import { uploadPhoto } from "@/lib/api";
import { BigButton } from "@/components/field/BigButton";
import { PhoneScreen } from "@/components/field/PhoneScreen";
import { closeoutStorageKey, type CloseoutHandoff } from "../_lib/closeout";

type RecordingState = "idle" | "recording" | "uploading" | "done" | "unavailable";

export default function VoicePage() {
  const params = useParams<{ id: string }>();
  const jobId = params.id;
  const router = useRouter();

  const [recState, setRecState] = useState<RecordingState>("idle");
  const [voiceFileKey, setVoiceFileKey] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [firstTimeFix, setFirstTimeFix] = useState(true);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startRecording() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecState("unavailable");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void uploadRecording();
      };
      recorder.start();
      setRecState("recording");
    } catch {
      // Permission denied, no mic, insecure context, etc. — manual entry
      // below still works either way, so this never blocks close-out.
      setRecState("unavailable");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  async function uploadRecording() {
    setRecState("uploading");
    try {
      const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const ext = mimeType.includes("mp4") ? "mp4" : mimeType.includes("ogg") ? "ogg" : "webm";
      const file = new File([blob], `voice-note.${ext}`, { type: mimeType });

      // Reuses POST /jobs/:id/photos, phase="evidence" — see file header.
      const result = await uploadPhoto(jobId, file, "evidence", "voice_note");
      setVoiceFileKey(result.file);
      setRecState("done");
    } catch {
      // Offline/upload failure — the clip just isn't attached;
      // technician_voice_note_file stays optional either way, and the
      // manual transcript below is what the close-out actually requires.
      setRecState("idle");
    }
  }

  function toggleRecording() {
    if (recState === "recording") {
      stopRecording();
    } else {
      void startRecording();
    }
  }

  function confirm() {
    const payload: CloseoutHandoff = {
      first_time_fix: firstTimeFix,
      technician_note_transcript: note,
      technician_voice_note_file: voiceFileKey,
    };
    try {
      sessionStorage.setItem(closeoutStorageKey(jobId), JSON.stringify(payload));
    } catch {
      // sessionStorage unavailable — /done handles a missing key by
      // sending the technician back here rather than crashing.
    }
    router.push(`/field/jobs/${jobId}/done`);
  }

  const statusLabel =
    recState === "recording"
      ? "A gravar… toque para parar"
      : recState === "uploading"
        ? "A enviar…"
        : recState === "done"
          ? "Gravado e enviado"
          : recState === "unavailable"
            ? "Microfone indisponível — escreva abaixo"
            : "Toque para falar";

  return (
    <PhoneScreen title="Como correu?" onBack={() => router.push(`/field/jobs/${jobId}/tests`)}>
      <p className="text-base text-zinc-600">
        Conte pelas suas palavras. Não escolha categorias — o escritório trata disso.
      </p>

      <div className="mt-8 flex flex-col items-center">
        <button
          onClick={toggleRecording}
          disabled={recState === "uploading"}
          aria-label={recState === "recording" ? "Parar gravação" : "Gravar"}
          className={`w-32 h-32 rounded-full flex items-center justify-center ${
            recState === "recording" ? "bg-red-600 animate-pulse" : "bg-zinc-900"
          }`}
        >
          <Mic className="w-14 h-14 text-white" />
        </button>
        <div className="mt-4 text-lg font-medium">{statusLabel}</div>
      </div>

      <div className="mt-6">
        <label className="text-xs font-semibold text-zinc-500 uppercase" htmlFor="note">
          Nota (sempre disponível)
        </label>
        <textarea
          id="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Escreva o que se passou, mesmo que já tenha gravado áudio…"
          rows={5}
          className="mt-1 w-full p-3 rounded-xl bg-zinc-100 border-2 border-zinc-200 text-base"
        />
      </div>

      <div className="mt-4">
        <div className="text-xs font-semibold text-zinc-500 uppercase mb-2">
          Resolvido à primeira visita?
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setFirstTimeFix(true)}
            className={`flex-1 min-h-[56px] rounded-xl border-2 flex items-center justify-center gap-2 font-semibold ${
              firstTimeFix ? "border-green-600 bg-green-50 text-green-800" : "border-zinc-300 text-zinc-500"
            }`}
          >
            <CheckCircle2 className="w-5 h-5" /> Sim
          </button>
          <button
            onClick={() => setFirstTimeFix(false)}
            className={`flex-1 min-h-[56px] rounded-xl border-2 flex items-center justify-center gap-2 font-semibold ${
              !firstTimeFix ? "border-red-600 bg-red-50 text-red-800" : "border-zinc-300 text-zinc-500"
            }`}
          >
            <XCircle className="w-5 h-5" /> Não
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <BigButton tone="ghost" icon={Keyboard} onClick={() => document.getElementById("note")?.focus()}>
          Prefiro escrever
        </BigButton>
        <BigButton tone="green" disabled={!note} onClick={confirm}>
          Fechar trabalho
        </BigButton>
      </div>
    </PhoneScreen>
  );
}
