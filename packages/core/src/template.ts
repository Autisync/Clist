// Template engine validation — 04-API-SPEC.md §2, 03-schema.sql §4/§4a,
// architecture §5. The test_protocol body shape is validated strictly
// because it's the thing the compliance gate (ited-ref-mapping.md §7A.3)
// exists to protect; other kinds stay as a loosely-typed jsonb bag for now.

import { z } from "zod";

export const TemplateKind = z.enum([
  "checklist",
  "test_protocol",
  "document_pack",
  "report_assembly",
  "execution_steps",
  "deadline_rule",
]);
export type TemplateKind = z.infer<typeof TemplateKind>;

export const CreateTemplateRequest = z.object({
  kind: TemplateKind,
  code: z.string().min(1),
  title: z.string().min(1),
  forkedFrom: z.string().uuid().optional(),
});
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequest>;

// Tabela 6.12 / 6.17-shaped test, per seed.sql's worked example.
export const TestProtocolTest = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  unit: z.string(),
  dir: z.enum(["range", "min", "max"]),
  min: z.number().optional(),
  max: z.number().optional(),
  recommended: z.number().optional(),
  limit_ref: z.string(),
}).refine(
  (t) => (t.dir === "range" ? t.min !== undefined && t.max !== undefined
    : t.dir === "min" ? t.min !== undefined
      : t.max !== undefined),
  { message: "min/max required for the given dir" }
);
export type TestProtocolTest = z.infer<typeof TestProtocolTest>;

export const TestProtocolBody = z.object({
  network_type: z.enum(["PC", "CC", "FO", "SMATV"]),
  tests: z.array(TestProtocolTest).min(1),
});
export type TestProtocolBody = z.infer<typeof TestProtocolBody>;

// Other kinds: documented shapes exist in 03-schema.sql §4a but aren't
// exercised by Phase 1 (architecture §8 — "no job domain logic yet").
// Validate as a non-empty object for now rather than leaving it fully
// unchecked.
export const GenericTemplateBody = z.record(z.string(), z.unknown());

export const CreateTemplateVersionRequest = z.object({
  body: z.unknown(), // route handler picks the right schema by template.kind
});

// POST /templates/:id/versions/:version/activate — API spec §2.
export const ActivateTestProtocolRequest = z.object({
  verified_by: z.string().uuid(),
  verified_source: z.string().min(1),
});
export type ActivateTestProtocolRequest = z.infer<typeof ActivateTestProtocolRequest>;
