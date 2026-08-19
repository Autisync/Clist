// F15 — REF assembly validation. 06-phase3-compliance.md §4, 04-API-SPEC.md
// §7, 03-schema.sql §10 (ref_document.ficha_fields comment — the exact
// ANEXO shape below is copied from that comment, sourced from the real
// Procedimento Edição 2024 annex, ited-ref-mapping.md §7A.2, not guessed).
//
// Only reachable for ited_ready/ited_full tenants (403 otherwise) — enforced
// in routes/ref.ts, not here; this file only validates shape.

import { z } from "zod";

export const FichaInstaller = z.object({
  name: z.string(),
  // "N.º (ANACOM, OE, OET)" — app_user.professional_registration_number.
  // Nullable: an assigned technician may not have one on file yet, and the
  // office can still generate a draft REF to fill in the rest.
  professional_registration_number: z.string().nullable(),
});
export type FichaInstaller = z.infer<typeof FichaInstaller>;

export const FichaBuilding = z.object({
  address: z.string(),
  postal_code: z.string(),
  locality: z.string(),
  // "MANUAL ITED APLICÁVEL" — job.manual_edition ("ITED4") is the natural
  // source; free text because the ANEXO field itself is free text, not an
  // enum.
  manual_ited_applicable: z.string(),
});
export type FichaBuilding = z.infer<typeof FichaBuilding>;

export const CaboInstaladoTecnologia = z.enum(["PC", "CC", "FO"]);
export type CaboInstaladoTecnologia = z.infer<typeof CaboInstaladoTecnologia>;

export const CaboInstalado = z.object({
  tecnologia: CaboInstaladoTecnologia,
  marca_modelo: z.string(),
  // Classe RPC (Regulamento dos Produtos de Construção fire-reaction
  // class) — not modeled anywhere upstream (catalog_item has no such
  // field), so best-effort population always leaves this "" for office
  // completion via PATCH.
  classe_rpc: z.string(),
});
export type CaboInstalado = z.infer<typeof CaboInstalado>;

// Designação options exactly as listed on the real ANEXO's "OUTROS
// MATERIAIS E DISPOSITIVOS INSTALADOS" table (ited-ref-mapping.md §7A.2).
export const OutroMaterialDesignacao = z.enum([
  "Tomadas",
  "RC-PC",
  "RC-CC",
  "RC-FO",
  "RG-PC",
  "RG-CC",
  "RG-FO",
  "TDT (Antenas, DST e cabeça de rede)",
  "Tampa da CVM (classe EN124)",
  "CAM",
  "Outros",
]);
export type OutroMaterialDesignacao = z.infer<typeof OutroMaterialDesignacao>;

export const OutroMaterial = z.object({
  designacao: OutroMaterialDesignacao,
  marca_modelo: z.string(),
});
export type OutroMaterial = z.infer<typeof OutroMaterial>;

export const FichaFields = z.object({
  installer: FichaInstaller,
  building: FichaBuilding,
  cabos_instalados: z.array(CaboInstalado),
  outros_materiais: z.array(OutroMaterial),
  // Page-2 free text fields (ited-ref-mapping.md §7A.2) — always populated
  // as "" by the domain function, left for office editing via PATCH.
  documentacao_facultativa: z.string(),
  outras_identificacoes_relevantes: z.string(),
});
export type FichaFields = z.infer<typeof FichaFields>;

// POST /jobs/:id/ref — ref_id is normally office-assigned (it's the "ID do
// REF" the reconciliation trigger checks against termo_responsabilidade
// later, schema §10); left optional here so a draft REF can still be
// created before that's decided, with a job-code-derived placeholder
// filled in by the route (same pattern quotes.ts uses for job.code
// generation) that the office can correct via a later create with a real
// value, or simply treat as final if it's fine.
export const CreateRefDocumentRequest = z.object({
  ref_id: z.string().min(1).optional(),
});
export type CreateRefDocumentRequest = z.infer<typeof CreateRefDocumentRequest>;

// PATCH /jobs/:id/ref — ficha_fields is a *top-level* partial: any key
// present replaces that key's whole value (object or array); any key
// omitted is left untouched in the stored jsonb. This is "merge, not
// replace-whole-object" per 06-phase3-compliance.md §4 — the route does a
// shallow merge at this granularity, not a deep patch of nested arrays.
// attachments is a list of object-store keys to *add* to the existing
// attachments array (append, not replace) — "attaches documents", not
// "sets the document list".
//
// rotulo_affixed — F18 (06-phase3-compliance.md §7): whether the rótulo was
// affixed at the installation. A checkbox on this same REF flow, not a new
// endpoint or template kind, per that section's spec.
export const PatchRefDocumentRequest = z
  .object({
    ficha_fields: FichaFields.partial().optional(),
    attachments: z.array(z.string().min(1)).optional(),
    rotulo_affixed: z.boolean().optional(),
  })
  .refine(
    (v) => v.ficha_fields !== undefined || v.attachments !== undefined || v.rotulo_affixed !== undefined,
    { message: "at least one of ficha_fields, attachments, or rotulo_affixed is required" }
  );
export type PatchRefDocumentRequest = z.infer<typeof PatchRefDocumentRequest>;
