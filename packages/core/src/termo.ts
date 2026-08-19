// F16 — termo de responsabilidade tracking. 06-phase3-compliance.md §5,
// 04-API-SPEC.md §7, 03-schema.sql §10 (termo_responsabilidade). The termo
// itself is issued exclusively in ANACOM's reserved area — we prepare and
// track, we do not replace it (ited-ref-mapping.md §2.2). `anacom_area_ref`
// is the one manual bridge, kept deliberately as the only one
// (03-schema.sql's own column comment, architecture §6).
//
// Only reachable for ited_ready/ited_full tenants (403 otherwise) —
// enforced in routes/termo.ts, not here; this file only validates shape.

import { z } from "zod";

// The five required parties per ited-ref-mapping.md §2.2: the termo "must
// reach ANACOM, the dono da obra, the diretor da obra, the diretor de
// fiscalização da obra, and the building owner/administration within 10
// working days of installation completion."
export const TermoRecipientRole = z.enum([
  "anacom",
  "dono_da_obra",
  "diretor_da_obra",
  "diretor_de_fiscalizacao_da_obra",
  "proprietario_administracao_edificio",
]);
export type TermoRecipientRole = z.infer<typeof TermoRecipientRole>;

export const TermoRecipient = z.object({
  role: TermoRecipientRole,
  name: z.string().min(1).optional(),
  sent_at: z.string().datetime().nullable().optional(),
});
export type TermoRecipient = z.infer<typeof TermoRecipient>;

// POST /jobs/:id/termo — ref_id_field is checked against the job's
// existing ref_document.ref_id by fn_termo_ref_reconciliation
// (03-schema.sql §10) at insert time; the route catches that trigger's
// exception and translates it to a 422, same pattern routes/ref.ts already
// uses for the other direction (fn_ref_termo_reconciliation) — not
// re-validated here.
export const CreateTermoRequest = z.object({
  number: z.string().min(1),
  ref_id_field: z.string().min(1),
  issued_at: z.string().datetime(),
  anacom_area_ref: z.string().min(1).optional(),
});
export type CreateTermoRequest = z.infer<typeof CreateTermoRequest>;

// PATCH /jobs/:id/termo/recipients/:role — updates (or appends, if not yet
// present) one entry in termo_responsabilidade.recipients by role.
// Read-modify-write, no normalized child table (06-phase3-compliance.md
// §5) — the volume here is five rows per job, ever.
export const PatchTermoRecipientRequest = z.object({
  sent_at: z.string().datetime(),
});
export type PatchTermoRecipientRequest = z.infer<typeof PatchTermoRecipientRequest>;
