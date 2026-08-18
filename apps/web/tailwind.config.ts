import type { Config } from "tailwindcss";

/*
 * FieldReady visual identity (see CLAUDE.md / project brief — this was a
 * deliberate restyle away from the generic slate+blue+purple dashboard
 * default, toward a technical "instrument panel" look). Tailwind already
 * ships the cyan and zinc scales we need, so this file doesn't invent new
 * color tokens — it documents the CONVENTION for how the existing scales
 * are used across the app, so every page picks colors the same way:
 *
 *   - Accent / interactive:  cyan-600 (light bg) / cyan-400 (dark bg).
 *     Never blue. Used for links, primary buttons, active nav/tab state,
 *     focus rings.
 *   - Neutrals:              zinc-50 .. zinc-950. Never slate/gray.
 *     zinc-50/white = page/card background, zinc-200/300 = borders,
 *     zinc-500 = secondary text, zinc-900 = primary text / dark chrome
 *     (headers, phone shell background).
 *   - Category tint (checklist / catalog items):
 *       material  -> cyan  (text-cyan-600 / bg-cyan-50)
 *       equipment -> zinc, monochrome (text-zinc-500 / bg-zinc-100)
 *       doc       -> amber (text-amber-600 / bg-amber-50)
 *     Never purple anywhere in this app.
 *   - Semantic state (colorblind-safe — ALWAYS paired with an icon + word,
 *     never color alone):
 *       green = pass / ok
 *       red   = fail / danger
 *       amber = warning / pending / caution
 *   - Radius: office/desktop panels use `rounded` (4px), not `rounded-lg`
 *     (8px) — tighter reads as technical tooling. Phone touch targets
 *     (BigBtn, phone bezel/shell) use `rounded-xl`/`rounded-2xl` — that's a
 *     functional glove-friendly affordance, not decoration, so it stays
 *     more rounded than desktop chrome.
 *   - Numeric readouts (job codes, SKUs, prices, hours, %, test
 *     measurements, dashboard stats) are always `font-mono tabular-nums`.
 *   - Flat bordered panels (`border` + `bg-*`), no heavy drop shadows.
 */
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "Liberation Mono",
          "monospace",
        ],
      },
      colors: {
        // Semantic aliases onto the existing Tailwind scales — convenience
        // only, still just cyan/zinc/green/red/amber under the hood.
        accent: {
          DEFAULT: "#0891b2", // cyan-600
          dark: "#22d3ee", // cyan-400, for use on dark backgrounds
        },
      },
    },
  },
  plugins: [],
};

export default config;
