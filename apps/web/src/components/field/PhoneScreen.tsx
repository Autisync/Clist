/*
 * Shared back+title header shell for phone screens that use it — direct
 * port of fieldready-prototype.jsx's <PhonePage> (CLAUDE.md: "treat its
 * interaction design as settled"). Not every phone screen uses this: the
 * prototype's "pin"/"home"/"prep"/"prepresult" screens each own a fully
 * custom full-bleed layout instead (dark keypad, job card, one-item
 * walkthrough, full-color result state) — this component is for the
 * PhonePage-style screens (e.g. "Carrinha 1", "No local" in the
 * prototype) that later stages will add under src/app/field/**.
 */

import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

export function PhoneScreen({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col h-full bg-white">
      <div className="flex items-center gap-2 px-3 py-3 border-b-2 border-zinc-100 shrink-0">
        <button
          onClick={onBack}
          aria-label="Voltar"
          className="p-2 -ml-1 min-w-[44px] min-h-[44px] flex items-center justify-center"
        >
          <ChevronLeft className="w-6 h-6 text-zinc-600" />
        </button>
        <span className="text-base font-semibold">{title}</span>
      </div>
      <div className="flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}
