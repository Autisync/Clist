/*
 * Job detail — three-stage tabs (Readiness / Execução / After-action
 * report), structure ported from fieldready-prototype.jsx's <JobDetail>
 * per CLAUDE.md ("treat its interaction design as settled").
 *
 * This stage builds the Readiness tab fully:
 *   - GET /jobs/:id/readiness → checklist items grouped by scope (job/van/
 *     office), each its own section with a done/total pill.
 *   - job/van items are directly togglable (office PATCH
 *     /jobs/:id/checklist/:item_id, matching the prototype's checkbox
 *     interaction); office-scope items render read-only, per the
 *     prototype's documented intent ("auto-verified, never touched here").
 *   - readiness summary banner + "Despachar trabalho" (POST
 *     /jobs/:id/dispatch), with real handling of both 409 shapes
 *     (not_ready → render the server-computed blocking list; wrong_status →
 *     distinct "already past this stage" message).
 *
 * Execução and After-action report are stubbed placeholder tabs (later
 * stages) — clicking them never breaks the page, they just show a calm
 * "ainda não implementado" panel instead of fetching data that doesn't
 * exist yet.
 *
 * There is no GET /jobs/:id/... route that returns the client's name, and
 * no GET /clients/:id (checked apps/api/src/routes/clients.ts — only the
 * tenant-scoped list) — same pattern as quotes/[id]/page.tsx: fetch
 * GET /clients and find by id server-side, not a second route that doesn't
 * exist.
 */

import { notFound } from "next/navigation";
import { Briefcase } from "lucide-react";
import { serverApiFetch, ApiError } from "@/lib/api";
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

type Client = { id: string; name: string; address: string | null };

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

  let job: Job;
  try {
    job = await serverApiFetch<Job>(`/jobs/${id}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const [{ clients }, readiness] = await Promise.all([
    serverApiFetch<{ clients: Client[] }>("/clients"),
    serverApiFetch<Readiness>(`/jobs/${id}/readiness`),
  ]);

  const client = clients.find((c) => c.id === job.client_id) ?? null;

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

      <JobDetail job={job} clientName={client?.name ?? null} initialReadiness={readiness} />
    </div>
  );
}
