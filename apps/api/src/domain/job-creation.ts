// 05-phase2-job-loop.md §4 — the one piece of Phase 2 logic that doesn't
// already exist as a pattern from Phase 1: resolving the template engine
// (built, unused until now) into a job's frozen checklist/execution/
// test-protocol snapshots, at job-creation time, once, per architecture §5's
// "resolved once, never re-read" rule.
//
// Kept pure of any Fastify types (only PGliteTx) so it's unit-testable
// standalone, same as dispatch-gate.ts wants to be (§4's own implementation
// note) — the route (routes/quotes.ts) is the only thing that knows about
// HTTP.

import type { PGliteTx } from "../db.js";

export type ResolvedTemplateBody = Record<string, unknown>;

export type CreateJobFromQuoteParams = {
  tx: PGliteTx;
  tenantId: string;
  jobId: string;
  quoteId: string;
  jobType: string;
};

export type CreateJobFromQuoteResult = {
  job_id: string;
  checklist: {
    total: number;
    by_scope: { job: number; van: number; office: number };
    merged_from_quote: number;
  };
  has_execution_snapshot: boolean;
  has_test_protocol_snapshot: boolean;
};

type ReadinessItem = {
  cat: "material" | "equipment" | "doc";
  label: string;
  qty?: number;
  item_id?: string | null;
  scope: "job" | "van" | "office";
  mandatory?: boolean;
};

// slugify job_type into the convention's `<slug>` half: lowercase,
// diacritics stripped to ascii, anything else collapsed to a single hyphen,
// leading/trailing hyphens trimmed. "TDT — instalação nova" -> "tdt-instalacao-nova".
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Resolves the ACTIVE template_version body for a given (kind, code),
// preferring a tenant-owned template over the system fallback. RLS on
// `template` (03-schema.sql §12) already restricts the rows this query can
// even see to "this tenant's own + system" — no redundant tenant_id filter
// here, so this can never diverge from RLS's own rule (§4 step 1's explicit
// instruction). Ordering by `layer = 'tenant'` picks the tenant's own row
// first when both a tenant-owned and a system template share the same code;
// falls through to the system row otherwise.
async function resolveActiveTemplateVersion(
  tx: PGliteTx,
  kind: string,
  code: string
): Promise<ResolvedTemplateBody | null> {
  const rows = await tx.query<{ body: ResolvedTemplateBody }>(
    `select tv.body
     from template t
     join template_version tv on tv.template_id = t.id
     where t.kind = $1 and t.code = $2 and tv.status = 'active'
     order by (t.layer = 'tenant') desc
     limit 1;`,
    [kind, code]
  );
  return rows.rows[0]?.body ?? null;
}

// Review finding (medium, apps/api/src/domain/job-creation.ts:129): unlike
// `readiness_<slug>`/`execution_<slug>`, seed.sql's verified test_protocol
// templates are NOT coded by job-type slug -- they're coded e.g.
// `coax_smatv_tt_tabela_6_12` and `fibra_optica_tabela_6_17`
// (seed.sql:54,94), keyed by which network they test, because a single
// test_protocol is reused across every job that touches that network
// regardless of job_type wording. Resolving by a `test_protocol_<slug>`
// code (the old convention here) can never match those rows, so §7's whole
// rationale for building F13/F14 capture in Phase 2 -- "already seeded,
// verified, and activatable" -- was unreachable from real job creation.
//
// Fix: resolve by `network_type` instead of by code, same as
// `job_test_result.network_type` already does (03-schema.sql §9). job_type
// itself has no structured network_type field yet (03-schema.sql: "free
// text v1"), so `inferNetworkTypeFromJobType` is a documented, narrow
// keyword heuristic over the job_type text.
//
// 06-phase3-compliance.md §2a: now that F11 (PC, Tabela 6.1) and F12 (CC,
// Tabela 6.4/6.7/6.9) are seeded and verified alongside F13/F14, this
// heuristic covers all four network types -- CC is checked before the
// generic coax/SMATV branch, since "coletiva"/"colectiva" is the word that
// distinguishes a distribution-network coax job (F12) from a per-outlet
// coax-TT job (F13/SMATV), which both otherwise match on "coax"/"coaxial".
// A job_type matching none of these keywords still infers to null and
// falls through to "no protocol resolved", same as before this extension.
function inferNetworkTypeFromJobType(jobType: string): "SMATV" | "FO" | "PC" | "CC" | null {
  const tokens = slugify(jobType).split("-");
  const has = (...words: string[]) => words.some((w) => tokens.includes(w));
  if (has("fibra", "fibre", "optica", "otica", "fo")) return "FO";
  if (has("coletiva", "colectiva")) return "CC";
  if (has("tdt", "coax", "coaxial", "smatv", "sat", "antena", "mastro")) return "SMATV";
  if (has("estruturada", "cablagem", "utp", "ftp", "rj45", "cat6", "cat5e")) return "PC";
  return null;
}

// Resolves the ACTIVE test_protocol template_version whose body's
// `network_type` matches, tenant-owned preferred over system (same
// layer-preference rule as `resolveActiveTemplateVersion`, and same RLS
// visibility guarantee -- no redundant tenant_id filter here either).
// `t.code` is an arbitrary tiebreaker for determinism if a tenant somehow
// has more than one active protocol for the same network_type at the same
// layer; it does not encode any resolution meaning of its own.
async function resolveActiveTestProtocolByNetworkType(
  tx: PGliteTx,
  networkType: "SMATV" | "FO" | "PC" | "CC"
): Promise<ResolvedTemplateBody | null> {
  const rows = await tx.query<{ body: ResolvedTemplateBody }>(
    `select tv.body
     from template t
     join template_version tv on tv.template_id = t.id
     where t.kind = 'test_protocol'
       and tv.status = 'active'
       and tv.body ->> 'network_type' = $1
     order by (t.layer = 'tenant') desc, t.code
     limit 1;`,
    [networkType]
  );
  return rows.rows[0]?.body ?? null;
}

/**
 * Resolves readiness/execution/test-protocol templates for `jobType`, writes
 * the resolved bodies verbatim into job.readiness_snapshot /
 * execution_snapshot / test_protocol_snapshot, materializes one
 * job_checklist_item row per resolved checklist item, and merges in any
 * quote_line not already covered by the resolved checklist (§4 steps 1-4).
 *
 * Caller (routes/quotes.ts POST /quotes/:id/create-job) is responsible for
 * having already inserted the `job` row (with quoted_hours/quoted_materials
 * copied from the quote and status defaulting to 'ready_check' per the
 * schema default) before calling this — this function only resolves and
 * writes the snapshot/checklist side of job creation.
 */
export async function createJobFromQuote(
  params: CreateJobFromQuoteParams
): Promise<CreateJobFromQuoteResult> {
  const { tx, tenantId, jobId, quoteId, jobType } = params;
  const slug = slugify(jobType);

  const tenantRows = await tx.query<{ compliance_profile: string }>(
    `select compliance_profile from tenant where id = $1;`,
    [tenantId]
  );
  const complianceProfile = tenantRows.rows[0]?.compliance_profile ?? "basic";

  // 1/2. Readiness checklist — tenant template first, system fallback, or
  // no template at all (§4 step 1: "if truly nothing matches either way,
  // proceed with an empty checklist rather than erroring").
  const readinessBody = await resolveActiveTemplateVersion(tx, "checklist", `readiness_${slug}`);
  const readinessItems: ReadinessItem[] = Array.isArray(readinessBody?.items)
    ? (readinessBody!.items as ReadinessItem[])
    : [];

  // 3. Execution steps, same resolution, different code convention.
  const executionBody = await resolveActiveTemplateVersion(
    tx,
    "execution_steps",
    `execution_${slug}`
  );

  // 4. Test protocol — only for non-basic compliance profiles. Phase 2
  // wired F13 (SMATV) and F14 (FO); 06-phase3-compliance.md §2/§2a extends
  // the same resolution to F11 (PC) and F12 (CC) now that both are sourced,
  // seeded, and verified (seed.sql, verify-seed.mjs) — no protocol-specific
  // branching needed here, `inferNetworkTypeFromJobType` and
  // `resolveActiveTestProtocolByNetworkType` already generalize to all four.
  let testProtocolBody: ResolvedTemplateBody | null = null;
  if (complianceProfile !== "basic") {
    const networkType = inferNetworkTypeFromJobType(jobType);
    if (networkType) {
      testProtocolBody = await resolveActiveTestProtocolByNetworkType(tx, networkType);
    }
  }

  // Materialize job_checklist_item rows from the resolved readiness
  // checklist, tracking which catalog items are already covered so the
  // quote-line merge (step 4) doesn't duplicate them.
  const coveredItemIds = new Set<string>();
  const byScope = { job: 0, van: 0, office: 0 };

  for (const item of readinessItems) {
    const itemId = item.item_id ?? null;
    const qty = item.qty ?? 1;
    const mandatory = item.mandatory ?? true;
    await tx.query(
      `insert into job_checklist_item (tenant_id, job_id, cat, label, qty, item_id, scope, mandatory, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'missing');`,
      [tenantId, jobId, item.cat, item.label, qty, itemId, item.scope, mandatory]
    );
    byScope[item.scope] += 1;
    if (itemId) coveredItemIds.add(itemId);
  }

  // 4. Merge quote_line rows not already covered by the resolved checklist.
  // A line with no item_id (free-text BOM entry) can never be "covered" by
  // anything, so it always merges; a line with an item_id merges only if
  // that item_id wasn't already materialized above.
  const quoteLines = await tx.query<{ item_id: string | null; description: string; qty: string }>(
    `select item_id, description, qty from quote_line where quote_id = $1 and tenant_id = $2;`,
    [quoteId, tenantId]
  );

  let mergedFromQuote = 0;
  for (const line of quoteLines.rows) {
    const alreadyCovered = line.item_id != null && coveredItemIds.has(line.item_id);
    if (alreadyCovered) continue;

    await tx.query(
      `insert into job_checklist_item (tenant_id, job_id, cat, label, qty, item_id, scope, mandatory, status)
       values ($1, $2, 'material', $3, $4, $5, 'job', true, 'missing');`,
      [tenantId, jobId, line.description, line.qty, line.item_id]
    );
    byScope.job += 1;
    mergedFromQuote += 1;
    if (line.item_id) coveredItemIds.add(line.item_id);
  }

  // 2/3/4. Freeze the resolved bodies into the job row, verbatim, once.
  await tx.query(
    `update job
     set readiness_snapshot = $1, execution_snapshot = $2, test_protocol_snapshot = $3
     where id = $4 and tenant_id = $5;`,
    [
      readinessBody ? JSON.stringify(readinessBody) : null,
      executionBody ? JSON.stringify(executionBody) : null,
      testProtocolBody ? JSON.stringify(testProtocolBody) : null,
      jobId,
      tenantId,
    ]
  );

  return {
    job_id: jobId,
    checklist: {
      total: byScope.job + byScope.van + byScope.office,
      by_scope: byScope,
      merged_from_quote: mergedFromQuote,
    },
    has_execution_snapshot: executionBody !== null,
    has_test_protocol_snapshot: testProtocolBody !== null,
  };
}
