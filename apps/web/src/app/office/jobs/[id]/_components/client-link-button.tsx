"use client";

/*
 * Client-facing portal — office half. A single button: calling
 * rpc_job_generate_client_link either returns the job's existing
 * capability token or generates one on first use (that RPC's own
 * coalesce(...) is what makes "always just call it" safe and correct
 * either way — this component never needs to know in advance whether a
 * token already exists).
 *
 * The RPC call and the clipboard write are deliberately kept as two
 * separate failure domains, not one try/catch. `navigator.clipboard`
 * needs a secure context AND a genuine, still-active user-activation
 * window — real users hit this on browsers/extensions that block
 * clipboard-write, or simply lose activation to a slow network round
 * trip. A first version of this component collapsed both into one
 * catch: when the clipboard write threw, it swallowed the fact that the
 * RPC had ALREADY SUCCEEDED and durably written client_access_token to
 * the job row, and showed a generic, unrecoverable "não foi possível"
 * error — the token existed in the database but the office user had no
 * way to ever see it (confirmed empirically: a real click reproduced
 * exactly this, and a direct DB check showed client_access_token was
 * set despite the on-screen error). Fixed by always rendering the
 * resulting URL once the RPC succeeds, regardless of whether the
 * clipboard write itself succeeded — copy is a convenience on top of
 * that, not the only way to retrieve the link.
 */

import { useState } from "react";
import { Link2, Check, Copy } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function ClientLinkButton({ jobId }: { jobId: string }) {
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const supabase = createSupabaseBrowserClient();
      const { data, error: rpcError } = await supabase.rpc("rpc_job_generate_client_link", {
        p_job_id: jobId,
      });
      if (rpcError) throw rpcError;
      if (data?.kind !== "ok") throw new Error(data?.kind ?? "unknown_error");
      const generatedUrl = `${window.location.origin}/track/${data.token}`;
      setUrl(generatedUrl);
      // Best-effort only — a failure here must never hide the link
      // itself, since the token is already generated either way.
      try {
        await navigator.clipboard.writeText(generatedUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 3000);
      } catch {
        // Link is still shown below for manual copy; nothing else to do.
      }
    } catch {
      setError("Não foi possível gerar o link.");
    } finally {
      setLoading(false);
    }
  }

  async function copyAgain() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Manual select-and-copy from the visible field below still works.
    }
  }

  if (url) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="w-56 px-2 py-1.5 text-xs font-mono border border-zinc-300 rounded bg-zinc-50 text-zinc-700"
        />
        <button
          type="button"
          onClick={copyAgain}
          title="Copiar link"
          className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-cyan-700 border border-cyan-300 rounded hover:bg-cyan-50"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={generate}
        disabled={loading}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cyan-700 border border-cyan-300 rounded hover:bg-cyan-50 disabled:opacity-50"
      >
        <Link2 className="w-3.5 h-3.5" />
        {loading ? "A gerar…" : "Copiar link para o cliente"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
