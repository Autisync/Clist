// F15 — REF assembly. 06-phase3-compliance.md §4: populates
// ref_document.ficha_fields from what the job already knows, leaving
// documentacao_facultativa/outras_identificacoes_relevantes as "" for
// office editing via PATCH /jobs/:id/ref (routes/ref.ts).
//
// Kept pure of any Fastify types (only PGliteTx), same principle as
// dispatch-gate.ts/job-creation.ts, so it's callable from the route without
// needing a request object.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import type { PGliteTx } from "../db.js";
import type { CaboInstaladoTecnologia, FichaFields, OutroMaterialDesignacao } from "@fieldready/core";
import type { ObjectStore } from "../object-store.js";

// Same "read straight from the source tree, not from tsc's dist output"
// pattern db.ts uses for 03-schema.sql/seed.sql — ref.html is a template
// asset, not TypeScript, so tsc never copies it into dist either. Resolve
// up to the repo root the same way db.ts does, then back down via an
// explicit src/ path so this works identically whether the running code is
// tsx-from-src (dev) or tsc-built-into-dist (this file lives at the same
// depth, apps/api/src/domain vs apps/api/dist/domain, either way).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../");
const REF_HTML_TEMPLATE_PATH = path.join(REPO_ROOT, "apps/api/src/templates/ref.html");

/**
 * Best-effort keyword match from a free-text label/description (job
 * material checklist labels, quote_line.description — neither carries a
 * structured category, catalog_item has no category column either) to a
 * REF "CABOS INSTALADOS" tecnologia. A line matching this table is a cable
 * run, not a device, so it never also lands in outros_materiais.
 */
const CABLE_KEYWORD_MAP: ReadonlyArray<{ tecnologia: CaboInstaladoTecnologia; keywords: string[] }> = [
  { tecnologia: "FO", keywords: ["fibra ótica", "fibra optica", "fibra", "ótica", "optica"] },
  { tecnologia: "CC", keywords: ["coaxial", "coax"] },
  { tecnologia: "PC", keywords: ["par de cobre", "pares de cobre", "cat 6", "cat6", "cat 5e", "cat5e", "utp", "ftp"] },
];

/**
 * Same idea for the "OUTROS MATERIAIS E DISPOSITIVOS INSTALADOS" table
 * (ited-ref-mapping.md §7A.2) — designações exactly as they appear on the
 * real ANEXO. Order matters: more specific keywords (RC-PC, RG-FO, ...)
 * are checked before the generic ones so "repartidor" alone doesn't win
 * over a more specific match earlier in a longer label.
 */
const MATERIAL_KEYWORD_MAP: ReadonlyArray<{ designacao: OutroMaterialDesignacao; keywords: string[] }> = [
  { designacao: "RC-PC", keywords: ["rc-pc", "repartidor de cliente pc", "repartidor de cliente — pc"] },
  { designacao: "RC-CC", keywords: ["rc-cc", "repartidor de cliente cc", "repartidor de cliente — cc"] },
  { designacao: "RC-FO", keywords: ["rc-fo", "repartidor de cliente fo", "repartidor de cliente — fo"] },
  { designacao: "RG-PC", keywords: ["rg-pc", "repartidor geral pc", "repartidor geral — pc"] },
  { designacao: "RG-CC", keywords: ["rg-cc", "repartidor geral cc", "repartidor geral — cc"] },
  { designacao: "RG-FO", keywords: ["rg-fo", "repartidor geral fo", "repartidor geral — fo"] },
  {
    designacao: "TDT (Antenas, DST e cabeça de rede)",
    keywords: ["antena", "dst", "cabeça de rede", "cabeca de rede", "lnb", "amplificador"],
  },
  { designacao: "Tampa da CVM (classe EN124)", keywords: ["tampa", "cvm", "en124", "en 124"] },
  { designacao: "CAM", keywords: ["cam"] },
  { designacao: "Tomadas", keywords: ["tomada"] },
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // strip accents so "ótica"/"otica" both match
}

function matchCable(text: string): CaboInstaladoTecnologia | null {
  const n = normalize(text);
  for (const entry of CABLE_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => n.includes(normalize(kw)))) return entry.tecnologia;
  }
  return null;
}

function matchMaterial(text: string): OutroMaterialDesignacao | null {
  const n = normalize(text);
  for (const entry of MATERIAL_KEYWORD_MAP) {
    if (entry.keywords.some((kw) => n.includes(normalize(kw)))) return entry.designacao;
  }
  return null;
}

/**
 * Builds ref_document.ficha_fields for `jobId` from:
 *   - installer: app_user.professional_registration_number for
 *     job.assigned_to (the technician assigned to the job)
 *   - building: job.address (falling back to client.address), plus
 *     job.manual_edition for "MANUAL ITED APLICÁVEL" — postal_code/locality
 *     have no source column anywhere upstream, left "" for office entry
 *   - cabos_instalados/outros_materiais: best-effort keyword match over
 *     job_checklist_item (cat='material') labels and, when the job has a
 *     quote, quote_line descriptions — text that matches neither table is
 *     simply left out rather than dumped into a catch-all category
 *   - documentacao_facultativa/outras_identificacoes_relevantes: always "",
 *     office-only free text via PATCH
 */
export async function populateFichaFields(
  tx: PGliteTx,
  _tenantId: string,
  jobId: string
): Promise<FichaFields> {
  const jobRows = await tx.query<{
    client_id: string;
    address: string | null;
    assigned_to: string | null;
    manual_edition: string | null;
    quote_id: string | null;
  }>(
    `select client_id, address, assigned_to, manual_edition, quote_id from job where id = $1;`,
    [jobId]
  );
  const job = jobRows.rows[0];
  if (!job) throw new Error(`populateFichaFields: job ${jobId} not found`);

  const clientRows = await tx.query<{ address: string | null }>(
    `select address from client where id = $1;`,
    [job.client_id]
  );
  const clientAddress = clientRows.rows[0]?.address ?? null;

  let installerName = "";
  let installerRegNumber: string | null = null;
  if (job.assigned_to) {
    const userRows = await tx.query<{
      full_name: string;
      professional_registration_number: string | null;
    }>(
      `select full_name, professional_registration_number from app_user where id = $1;`,
      [job.assigned_to]
    );
    const user = userRows.rows[0];
    if (user) {
      installerName = user.full_name;
      installerRegNumber = user.professional_registration_number;
    }
  }

  const checklistRows = await tx.query<{ label: string }>(
    `select label from job_checklist_item where job_id = $1 and cat = 'material';`,
    [jobId]
  );
  const quoteLineRows = job.quote_id
    ? await tx.query<{ description: string }>(
        `select description from quote_line where quote_id = $1;`,
        [job.quote_id]
      )
    : { rows: [] as { description: string }[] };

  const candidateTexts = [
    ...checklistRows.rows.map((r) => r.label),
    ...quoteLineRows.rows.map((r) => r.description),
  ];

  const cabosByKey = new Map<string, { tecnologia: CaboInstaladoTecnologia; marca_modelo: string; classe_rpc: string }>();
  const materiaisByKey = new Map<string, { designacao: OutroMaterialDesignacao; marca_modelo: string }>();

  for (const text of candidateTexts) {
    const tecnologia = matchCable(text);
    if (tecnologia) {
      const key = `${tecnologia}::${text}`;
      if (!cabosByKey.has(key)) {
        cabosByKey.set(key, { tecnologia, marca_modelo: text, classe_rpc: "" });
      }
      continue; // a cable line is a cable line, never also an "outros materiais" row
    }
    const designacao = matchMaterial(text);
    if (designacao) {
      const key = `${designacao}::${text}`;
      if (!materiaisByKey.has(key)) {
        materiaisByKey.set(key, { designacao, marca_modelo: text });
      }
    }
  }

  return {
    installer: {
      name: installerName,
      professional_registration_number: installerRegNumber,
    },
    building: {
      address: job.address ?? clientAddress ?? "",
      postal_code: "",
      locality: "",
      manual_ited_applicable: job.manual_edition ?? "",
    },
    cabos_instalados: [...cabosByKey.values()],
    outros_materiais: [...materiaisByKey.values()],
    documentacao_facultativa: "",
    outras_identificacoes_relevantes: "",
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emptyRow(colspan: number): string {
  return `<tr><td colspan="${colspan}" class="empty">(nenhum)</td></tr>`;
}

/**
 * Interpolates `refId`/`createdAt`/`fichaFields` into templates/ref.html.
 * Every free-text value is HTML-escaped before interpolation — this data
 * ultimately comes from job/client/app_user rows and office-edited jsonb,
 * not from a source we control end to end.
 */
export function renderRefHtml(refId: string, createdAt: Date, fichaFields: FichaFields): string {
  const template = readFileSync(REF_HTML_TEMPLATE_PATH, "utf8");

  const cabosRows = fichaFields.cabos_instalados.length
    ? fichaFields.cabos_instalados
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.tecnologia)}</td><td>${escapeHtml(c.marca_modelo)}</td><td>${escapeHtml(c.classe_rpc)}</td></tr>`
        )
        .join("\n")
    : emptyRow(3);

  const materiaisRows = fichaFields.outros_materiais.length
    ? fichaFields.outros_materiais
        .map((m) => `<tr><td>${escapeHtml(m.designacao)}</td><td>${escapeHtml(m.marca_modelo)}</td></tr>`)
        .join("\n")
    : emptyRow(2);

  const replacements: Record<string, string> = {
    ID_DO_REF: escapeHtml(refId),
    DATA: createdAt.toISOString().slice(0, 10),
    INSTALLER_NAME: escapeHtml(fichaFields.installer.name) || '<span class="empty">(por preencher)</span>',
    INSTALLER_REG:
      escapeHtml(fichaFields.installer.professional_registration_number ?? "") ||
      '<span class="empty">(por preencher)</span>',
    BUILDING_ADDRESS: escapeHtml(fichaFields.building.address) || '<span class="empty">(por preencher)</span>',
    BUILDING_POSTAL_CODE:
      escapeHtml(fichaFields.building.postal_code) || '<span class="empty">(por preencher)</span>',
    BUILDING_LOCALITY: escapeHtml(fichaFields.building.locality) || '<span class="empty">(por preencher)</span>',
    MANUAL_ITED_APPLICABLE:
      escapeHtml(fichaFields.building.manual_ited_applicable) || '<span class="empty">(por preencher)</span>',
    CABOS_ROWS: cabosRows,
    MATERIAIS_ROWS: materiaisRows,
    DOCUMENTACAO_FACULTATIVA:
      escapeHtml(fichaFields.documentacao_facultativa) || '<span class="empty">(nenhuma)</span>',
    OUTRAS_IDENTIFICACOES_RELEVANTES:
      escapeHtml(fichaFields.outras_identificacoes_relevantes) || '<span class="empty">(nenhuma)</span>',
  };

  return Object.entries(replacements).reduce(
    (html, [token, value]) => html.replaceAll(`{{${token}}}`, value),
    template
  );
}

/**
 * Renders `html` to PDF bytes via Playwright headless Chromium
 * (06-phase3-compliance.md §4 — this is the mechanism architecture §2
 * specifies; confirmed launching cleanly in this dev environment, so no
 * README stack-substitution note is needed, unlike PGlite's).
 */
export async function renderPdfFromHtml(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    return pdf;
  } finally {
    await browser.close();
  }
}

/**
 * Full POST /jobs/:id/ref/generate-pdf pipeline: render the HTML template
 * with `refId`/`createdAt`/`fichaFields`, print it to PDF, and write the
 * bytes through the existing ObjectStore (05-phase2-job-loop.md §7's
 * interface, reused as-is — no second object-storage mechanism). Returns
 * the object-store key the caller writes to ref_document.generated_pdf.
 */
export async function generateRefPdf(
  objectStore: ObjectStore,
  key: string,
  refId: string,
  createdAt: Date,
  fichaFields: FichaFields
): Promise<string> {
  const html = renderRefHtml(refId, createdAt, fichaFields);
  const pdf = await renderPdfFromHtml(html);
  return objectStore.put(key, pdf);
}
