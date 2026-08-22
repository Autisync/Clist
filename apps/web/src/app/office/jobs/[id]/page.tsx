/*
 * Job detail — three-stage tabs (Readiness / Execução / After-action
 * report), structure ported from fieldready-prototype.jsx's <JobDetail>
 * per CLAUDE.md ("treat its interaction design as settled").
 *
 * §6 Step 5: reads now go straight to Supabase (RLS-scoped, real HTTP over
 * PostgREST) via the server client, matching office/jobs/page.tsx's own
 * cutover — job row, client name, and checklist items (v_job_readiness +
 * job_checklist_item) each a direct `.from(...)` query instead of
 * GET /jobs/:id / GET /clients / GET /jobs/:id/readiness through Fastify.
 * v_job_readiness is a LEFT JOIN ... GROUP BY (03-schema.sql §13) so every
 * existing job has exactly one row there — a missing job row is the only
 * real not-found case, not a separate one to handle for the view.
 *
 * All three tabs' write actions (checklist toggle, dispatch, execution
 * steps, test results, complete, closeout, rework-cause) are wired to the
 * same Supabase project from job-detail.tsx — see that file's own comment
 * for which RPC backs each one, and rpc_job_complete's new addition to
 * rpc.sql for the one write that needed a new function. Photo upload alone
 * stays Fastify-backed (binary bytes, no Supabase Storage wiring in this
 * slice — same "structurally can't be an RPC" reasoning as REF PDF
 * generation and Veryfi OCR, 08-supabase-native-migration.md §4).
 */

import { notFound } from "next/navigation";
import { Briefcase } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { JobDetail } from "./_components/job-detail";

// execution_steps template body, frozen onto the job row at creation time —
// 03-schema.sql §4a: "execution_steps: { steps: [{ order, label }] }".
export type ExecutionSnapshot = { steps: { order: number; label: string }[] } | null;

// Tabela 6.1/6.7/6.9/6.12/6.17-shaped test protocol, frozen onto the job row
// at creation time — packages/core/src/template.ts's TestProtocolBody/Test.
// "external_pass_fail" (Phase 3, F11/Tabela 6.1) added here to match —
// letting this drift from the real shared type is exactly how threshLabel()
// broke for F11 tests before this fix (TypeScript couldn't catch a mismatch
// this local copy hid from it).
export type TestProtocolTest = {
  id: string;
  label: string;
  unit: string;
  dir: "range" | "min" | "max" | "external_pass_fail";
  min?: number;
  max?: number;
  recommended?: number;
  limit_ref: string;
};
export type TestProtocolSnapshot = {
  network_type: "PC" | "CC" | "FO" | "SMATV";
  tests: TestProtocolTest[];
} | null;

type Job = {
  id: string;
  client_id: string;
  code: string;
  title: string;
  address: string | null;
  job_type: string;
  scheduled_at: string | null;
  quoted_hours: string;
  quoted_materials: string;
  actual_hours: string | null;
  actual_materials: string | null;
  assigned_to: string | null;
  status: string;
  ited_classification: string;
  ited_classification_note: string | null;
  ited_classification_by: string | null;
  execution_snapshot: ExecutionSnapshot;
  test_protocol_snapshot: TestProtocolSnapshot;
  completed_at: string | null;
  created_at: string;
};

export type ChecklistItem = {
  id: string;
  cat: "material" | "equipment" | "doc";
  label: string;
  qty: string | number;
  item_id: string | null;
  scope: "job" | "van" | "office";
  mandatory: boolean;
  status: "ok" | "missing";
  updated_by: string | null;
  updated_at: string | null;
};

export type Readiness = {
  job_id: string;
  mandatory_total: number | string;
  mandatory_ok: number | string;
  readiness_pct: number | string | null;
  items: ChecklistItem[];
};

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: job, error: jobError } = await supabase
    .from("job")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) notFound();

  const [
    { data: client, error: clientError },
    { data: readinessSummary, error: readinessError },
    { data: items, error: itemsError },
  ] = await Promise.all([
    supabase.from("client").select("id, name, address").eq("id", job.client_id).maybeSingle(),
    supabase.from("v_job_readiness").select("*").eq("job_id", id).maybeSingle(),
    supabase
      .from("job_checklist_item")
      .select("id, cat, label, qty, item_id, scope, mandatory, status, updated_by, updated_at")
      .eq("job_id", id)
      .order("scope")
      .order("cat")
      .order("label"),
  ]);
  if (clientError) throw clientError;
  if (readinessError) throw readinessError;
  if (itemsError) throw itemsError;

  const readiness: Readiness = {
    job_id: id,
    mandatory_total: readinessSummary?.mandatory_total ?? 0,
    mandatory_ok: readinessSummary?.mandatory_ok ?? 0,
    readiness_pct: readinessSummary?.readiness_pct ?? null,
    items: (items ?? []) as ChecklistItem[],
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center gap-2">
        <Briefcase className="w-5 h-5 text-cyan-600" />
        <div>
          <h1 className="text-lg font-semibold text-zinc-900 font-mono tabular-nums">
            {job.code}
          </h1>
          <p className="text-xs text-zinc-500">{job.title}</p>
        </div>
      </div>

      <JobDetail job={job as Job} clientName={client?.name ?? null} initialReadiness={readiness} />
    </div>
  );
}
