"use client";

/*
 * Cookie consent — production-readiness item 5, companion to layout.tsx's
 * activation of Google Analytics (which sets tracking cookies, unlike
 * Vercel Analytics — see privacy/page.tsx §6 for why only this one needs
 * gating). GoogleAnalytics only ever mounts after the visitor explicitly
 * accepts; declining or not yet deciding both mean it stays unmounted, not
 * mounted-then-blocked — the ePrivacy-relevant thing (the cookie itself)
 * genuinely never gets set until consent is real.
 *
 * localStorage, not a cookie, to remember the choice itself — this is a
 * per-browser UI preference, not something any other viewer or the server
 * needs to see, matching this codebase's own established use of
 * localStorage for exactly this class of thing.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { GoogleAnalytics } from "@next/third-parties/google";

const STORAGE_KEY = "fieldready-cookie-consent";
type Consent = "accepted" | "declined" | null;

export function CookieConsent({ gaId }: { gaId?: string }) {
  const [consent, setConsent] = useState<Consent>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "accepted" || stored === "declined") setConsent(stored);
    } catch {
      // Private browsing / storage blocked — treat as "not yet decided",
      // same safe default as a first-ever visit. The banner just reappears
      // every load in that case, which is correct: there's nowhere to
      // durably remember a different answer.
    }
    setHydrated(true);
  }, []);

  function choose(value: "accepted" | "declined") {
    setConsent(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Nothing to persist to — the choice still applies for this page
      // load, it just won't survive a reload. Not worth surfacing as an
      // error to the visitor.
    }
  }

  return (
    <>
      {gaId && consent === "accepted" && <GoogleAnalytics gaId={gaId} />}

      {hydrated && consent === null && (
        <div className="fixed bottom-0 inset-x-0 z-50 bg-zinc-900 text-zinc-100 px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <p className="text-xs text-zinc-300 max-w-2xl">
            Usamos o Google Analytics para perceber como o FieldReady é usado. Só ativamos os
            cookies de análise com o seu consentimento —{" "}
            <Link href="/privacy" className="underline hover:text-white">
              saiba mais
            </Link>
            .
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => choose("declined")}
              className="px-3 py-1.5 text-xs text-zinc-300 hover:text-white"
            >
              Recusar
            </button>
            <button
              onClick={() => choose("accepted")}
              className="px-3 py-1.5 text-xs font-medium bg-cyan-600 text-white rounded hover:bg-cyan-700"
            >
              Aceitar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
