import type { Metadata } from "next";
import "./globals.css";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";

export const metadata: Metadata = {
  title: "FieldReady",
  description:
    "Field-readiness, after-action-report, and ITED-compliance webapp for telecom installers.",
  manifest: "/manifest.json",
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
  //
  // <RegisterServiceWorker /> registers /public/sw.js (the field-app-shell
  // offline cache) once for the whole app — was missing from this layout
  // despite both the component and manifest.json already existing; wired in
  // here per this stage's task 7.
  return (
    <html lang="pt">
      <body className="bg-zinc-50 text-zinc-900 antialiased">
        <RegisterServiceWorker />
        {children}
      </body>
    </html>
  );
}
