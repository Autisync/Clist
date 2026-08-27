import type { Metadata } from "next";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
import { GoogleAnalytics } from "@next/third-parties/google";
import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";

// Vercel Analytics needs no credential — it's a no-op everywhere except a
// real Vercel deployment, where the platform wires it up automatically, so
// <Analytics /> is unconditional. Google Analytics DOES need a real
// property id, which doesn't exist in this codebase — gated on
// NEXT_PUBLIC_GA_MEASUREMENT_ID (unset locally and in any environment that
// hasn't configured one yet) so it silently does nothing rather than
// shipping a broken gtag call, same "swap in when a real credential shows
// up" pattern this project already uses for GOOGLE_PLACES_API_KEY/VERYFI_*
// on the apps/api side. Set the var in Vercel's dashboard (Project
// Settings -> Environment Variables) with a real G-XXXXXXXXXX id to
// activate it — no code change needed after that.
const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

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
        <Analytics />
        {gaId && <GoogleAnalytics gaId={gaId} />}
      </body>
    </html>
  );
}
