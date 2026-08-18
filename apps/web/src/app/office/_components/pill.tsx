/*
 * Status pill — ported from fieldready-prototype.jsx's <Pill> (same tone
 * classes: zinc/green/red/amber/cyan). Shared across office pages (quotes,
 * jobs) instead of copy-pasted per page.
 */

export type PillTone = "zinc" | "green" | "red" | "amber" | "cyan";

const TONES: Record<PillTone, string> = {
  zinc: "bg-zinc-100 text-zinc-700",
  green: "bg-green-100 text-green-800",
  red: "bg-red-100 text-red-800",
  amber: "bg-amber-100 text-amber-800",
  cyan: "bg-cyan-100 text-cyan-800",
};

export function Pill({
  children,
  tone = "zinc",
}: {
  children: React.ReactNode;
  tone?: PillTone;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

// quote.status: draft | sent | accepted | declined (03-schema.sql §6).
export function quoteStatusLabel(status: string): { label: string; tone: PillTone } {
  switch (status) {
    case "draft":
      return { label: "Rascunho", tone: "zinc" };
    case "sent":
      return { label: "Enviado", tone: "amber" };
    case "accepted":
      return { label: "Aceite", tone: "green" };
    case "declined":
      return { label: "Recusado", tone: "red" };
    default:
      return { label: status, tone: "zinc" };
  }
}

// job.status: ready_check | dispatched | in_progress | testing | closed |
// cancelled (03-schema.sql §7).
export function jobStatusLabel(status: string): { label: string; tone: PillTone } {
  switch (status) {
    case "ready_check":
      return { label: "Pré-despacho", tone: "amber" };
    case "dispatched":
      return { label: "Despachado", tone: "cyan" };
    case "in_progress":
      return { label: "Em curso", tone: "cyan" };
    case "testing":
      return { label: "Em testes", tone: "cyan" };
    case "closed":
      return { label: "Concluído", tone: "green" };
    case "cancelled":
      return { label: "Cancelado", tone: "red" };
    default:
      return { label: status, tone: "zinc" };
  }
}
