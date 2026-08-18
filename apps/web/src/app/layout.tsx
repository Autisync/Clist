import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FieldReady",
  description:
    "Field-readiness, after-action-report, and ITED-compliance webapp for telecom installers.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Body text stays the default sans stack — the monospace family
  // (configured in tailwind.config.ts, system stack, no webfont) is applied
  // selectively via `font-mono` to numeric readouts, the wordmark, job
  // codes, etc., matching fieldready-prototype.jsx's convention rather than
  // forcing every character in the app into monospace.
  return (
    <html lang="pt">
      <body className="bg-zinc-50 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
