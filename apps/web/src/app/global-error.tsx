"use client";

/*
 * Global error boundary — Next.js's own required place to report an error
 * that crashes the ROOT layout itself (layout.tsx's own error boundary
 * can't catch a failure in layout.tsx), per @sentry/nextjs's manual setup
 * docs (sentry.server.config.ts's own comment on why this is manual, not
 * wizard-generated). Ordinary route errors already have their own
 * per-segment error.tsx boundaries elsewhere in this app tree — this one
 * exists specifically for the root-layout-crashed case, which is why it
 * has to render its own <html>/<body> (nothing else survived to do it).
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt">
      <body className="bg-zinc-50 text-zinc-900 antialiased">
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-sm text-center">
            <h1 className="text-lg font-semibold">Ocorreu um erro inesperado</h1>
            <p className="mt-2 text-sm text-zinc-500">
              A equipa foi notificada. Tente recarregar a página.
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
