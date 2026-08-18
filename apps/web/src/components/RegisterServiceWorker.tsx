"use client";

import { useEffect } from "react";

/**
 * Registers /public/sw.js (the field-app-shell offline cache) on mount.
 *
 * Renders nothing. Mount once in the root layout, e.g.:
 *
 *   import { RegisterServiceWorker } from "@/components/RegisterServiceWorker";
 *   // or a relative import matching this project's existing alias setup
 *   ...
 *   <body>
 *     <RegisterServiceWorker />
 *     {children}
 *   </body>
 *
 * Guarded so it is a no-op in environments without service worker support
 * (older browsers, some in-app webviews) and in development, where an
 * active service worker would otherwise fight the Next.js dev server's
 * hot-reload/asset serving.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // Never let a registration failure break the app shell.
      console.warn("service worker registration failed", err);
    });
  }, []);

  return null;
}

export default RegisterServiceWorker;
