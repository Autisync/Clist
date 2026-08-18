/*
 * Shared big tap-target button for the technician phone flow — direct port
 * of fieldready-prototype.jsx's <BigBtn> (CLAUDE.md: "treat its interaction
 * design as settled"). Same four tones (dark/green/red/ghost), same
 * py-4/rounded-xl/text-lg shape; the only addition is an explicit
 * min-h-[56px] to make the >=56px tap-target rule (project brief) hold even
 * if a future caller shrinks padding, rather than relying on py-4 alone.
 *
 * No "use client" directive here — this is a plain, hook-free leaf
 * component; it only ever renders inside already-client pages under
 * src/app/field/**, which is where the interactivity (onClick handlers,
 * state) actually lives.
 */

import type { ComponentType, ReactNode, SVGProps } from "react";

type Tone = "dark" | "green" | "red" | "ghost";

const TONE_CLASSES: Record<Tone, string> = {
  dark: "bg-zinc-900 text-white active:bg-zinc-700",
  green: "bg-green-600 text-white active:bg-green-700",
  red: "bg-red-600 text-white active:bg-red-700",
  ghost: "bg-white text-zinc-800 border-2 border-zinc-300 active:bg-zinc-100",
};

export function BigButton({
  children,
  onClick,
  tone = "dark",
  disabled,
  icon: Icon,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  disabled?: boolean;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`w-full min-h-[56px] py-4 px-4 rounded-xl text-lg font-semibold flex items-center justify-center gap-2 ${
        disabled ? "bg-zinc-200 text-zinc-400" : TONE_CLASSES[tone]
      }`}
    >
      {Icon && <Icon className="w-6 h-6" />}
      {children}
    </button>
  );
}
