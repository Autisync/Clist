"use client";

// print:hidden — this button has no reason to appear in the printed/
// saved-PDF output itself, only in the on-screen view that produces it.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="print:hidden flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-zinc-900 rounded hover:bg-zinc-800"
    >
      Imprimir / Guardar como PDF
    </button>
  );
}
