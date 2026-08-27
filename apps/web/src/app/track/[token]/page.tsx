/*
 * Client-facing portal — the public half. Deliberately OUTSIDE
 * office/field/admin entirely: no login, no account, reachable by anyone
 * holding the link (job.client_access_token, an unguessable capability
 * token — see rpc.sql's own comment on fn_track_job for the full
 * reasoning). middleware.ts's matcher only covers /office/*, /field/*,
 * /admin/* — this route was never going to be caught by any of those
 * checks, which is exactly right for a page that must work with zero
 * Supabase session at all.
 *
 * fn_track_job (rpc.sql) is a plain RPC call, same "no Fastify route
 * needed for a read" pattern this whole app already uses elsewhere —
 * granted to the `anon` role specifically, since a visitor here has no
 * session to be `authenticated` under. Photo bytes are the one thing that
 * DOES need a route (routes/track.ts) — binary data can't come back
 * through a jsonb RPC response cleanly, same reasoning photo upload/
 * receipt images/REF PDFs already established.
 */

import { CheckCircle2, Clock, XCircle, Radio, ImageOff } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type TrackPhoto = { id: string; phase: string; taken_at: string };
type TrackResult =
  | { kind: "not_found" }
  | { kind: "ok"; code: string; title: string; status: string; scheduled_at: string | null; photos: TrackPhoto[] };

// Deliberately its own vocabulary, not office's jobStatusLabel
// (office/_components/pill.tsx) — that one uses internal operational
// language ("Pré-despacho", "Em testes") aimed at installers, not the
// simpler framing an external client actually needs.
function clientStatusLabel(status: string): { label: string; icon: typeof Clock; tone: string } {
  switch (status) {
    case "ready_check":
    case "dispatched":
      return { label: "Agendado", icon: Clock, tone: "text-amber-700 bg-amber-50 border-amber-200" };
    case "in_progress":
    case "testing":
      return { label: "Em curso", icon: Clock, tone: "text-cyan-700 bg-cyan-50 border-cyan-200" };
    case "closed":
      return { label: "Concluído", icon: CheckCircle2, tone: "text-green-700 bg-green-50 border-green-200" };
    case "cancelled":
      return { label: "Cancelado", icon: XCircle, tone: "text-red-700 bg-red-50 border-red-200" };
    default:
      return { label: status, icon: Clock, tone: "text-zinc-700 bg-zinc-50 border-zinc-200" };
  }
}

const PHASE_LABEL: Record<string, string> = {
  before: "Antes",
  during: "Durante",
  after: "Depois",
  evidence: "Registo",
};

export default async function TrackJobPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("fn_track_job", { p_token: token });
  if (error) throw error;
  const result = data as TrackResult;

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-md mx-auto px-4 py-10">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <Radio className="w-5 h-5 text-cyan-600" strokeWidth={2.5} />
          <span className="font-mono font-bold uppercase tracking-wider text-lg">FieldReady</span>
        </div>

        {result.kind === "not_found" ? (
          <div className="bg-white border border-zinc-200 rounded p-6 text-center">
            <p className="text-sm text-zinc-600">
              Este link não é válido ou já não está disponível. Contacte a empresa que lhe
              enviou este link para obter um novo.
            </p>
          </div>
        ) : (
          <>
            <div className="bg-white border border-zinc-200 rounded p-5">
              <div className="text-xs font-mono text-zinc-400">{result.code}</div>
              <h1 className="text-lg font-semibold mt-0.5">{result.title}</h1>
              {result.scheduled_at && (
                <p className="text-sm text-zinc-500 mt-1">
                  {new Date(result.scheduled_at).toLocaleString("pt-PT", {
                    dateStyle: "long",
                    timeStyle: "short",
                  })}
                </p>
              )}
              {(() => {
                const { label, icon: Icon, tone } = clientStatusLabel(result.status);
                return (
                  <div className={`mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm font-medium ${tone}`}>
                    <Icon className="w-4 h-4" />
                    {label}
                  </div>
                );
              })()}
            </div>

            <div className="mt-4">
              <h2 className="text-sm font-semibold text-zinc-700 mb-2">Fotografias</h2>
              {result.photos.length === 0 ? (
                <div className="bg-white border border-dashed border-zinc-300 rounded p-6 text-center">
                  <ImageOff className="w-6 h-6 text-zinc-300 mx-auto" />
                  <p className="text-sm text-zinc-500 mt-2">
                    Ainda não há fotografias disponíveis para este trabalho.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {result.photos.map((p) => (
                    // eslint-disable-next-line @next/next/no-img-element -- a
                    // token-gated, server-proxied route, not a static asset
                    // next/image's optimizer has any reason to touch.
                    <div key={p.id} className="bg-white border border-zinc-200 rounded overflow-hidden">
                      <img
                        src={`/api/track/${token}/photos/${p.id}`}
                        alt={PHASE_LABEL[p.phase] ?? p.phase}
                        className="w-full aspect-square object-cover"
                      />
                      <div className="px-2 py-1.5 text-xs text-zinc-500 flex items-center justify-between">
                        <span>{PHASE_LABEL[p.phase] ?? p.phase}</span>
                        <span className="font-mono">
                          {new Date(p.taken_at).toLocaleDateString("pt-PT")}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
