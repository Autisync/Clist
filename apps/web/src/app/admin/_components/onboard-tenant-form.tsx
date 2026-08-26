"use client";

/*
 * Real tenant onboarding — POST /platform-admin/tenants
 * (apps/api/src/routes/platform-admin.ts), the UI replacement for running
 * apps/api/supabase/provision-tenant.mjs by hand. apiFetch (@/lib/api)
 * already attaches this admin session's real Supabase bearer token
 * automatically (the bridge-auth fix, lib/api.ts's own comment) — the
 * route's own requirePlatformAdmin gate is what actually authorizes this,
 * not anything client-side.
 *
 * slug auto-derived from the name (lowercase, non-alphanumeric -> hyphen)
 * but still editable — matches provision-tenant.mjs's own CLI UX of
 * passing both explicitly, just with a sensible default instead of
 * requiring the operator to type it twice.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";

const COMPLIANCE_PROFILES = [
  { value: "basic", label: "Básico" },
  { value: "ited_ready", label: "ITED pronto" },
  { value: "ited_full", label: "ITED completo" },
];

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (á -> a, ç -> c) after NFD decomposition
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function OnboardTenantForm() {
  const router = useRouter();
  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [complianceProfile, setComplianceProfile] = useState("ited_ready");
  const [officeName, setOfficeName] = useState("");
  const [officeEmail, setOfficeEmail] = useState("");
  const [officePassword, setOfficePassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function handleNameChange(value: string) {
    setTenantName(value);
    if (!slugTouched) setTenantSlug(slugify(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      await apiFetch("/platform-admin/tenants", {
        method: "POST",
        body: JSON.stringify({
          tenant_name: tenantName.trim(),
          tenant_slug: tenantSlug.trim(),
          compliance_profile: complianceProfile,
          office_name: officeName.trim(),
          office_email: officeEmail.trim(),
          office_password: officePassword,
        }),
      });
      setSuccess(`Empresa "${tenantName}" criada. ${officeName} já pode entrar em /login com o email indicado.`);
      setTenantName("");
      setTenantSlug("");
      setSlugTouched(false);
      setOfficeName("");
      setOfficeEmail("");
      setOfficePassword("");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as { error?: string; message?: string };
        setError(body.message ?? "Já existe um registo com estes dados.");
      } else {
        setError("Não foi possível criar a empresa. Tente novamente.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="tenantName" className="block text-xs font-medium text-zinc-400 mb-1">
            Nome da empresa
          </label>
          <input
            id="tenantName"
            type="text"
            required
            value={tenantName}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Antenas Rex, Lda"
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          />
        </div>
        <div>
          <label htmlFor="tenantSlug" className="block text-xs font-medium text-zinc-400 mb-1">
            Identificador (slug)
          </label>
          <input
            id="tenantSlug"
            type="text"
            required
            value={tenantSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setTenantSlug(e.target.value);
            }}
            placeholder="antenas-rex"
            className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          />
        </div>
      </div>

      <div>
        <label htmlFor="complianceProfile" className="block text-xs font-medium text-zinc-400 mb-1">
          Perfil de conformidade
        </label>
        <select
          id="complianceProfile"
          value={complianceProfile}
          onChange={(e) => setComplianceProfile(e.target.value)}
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
        >
          {COMPLIANCE_PROFILES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="border-t border-zinc-800 pt-3">
        <div className="text-xs font-semibold text-zinc-500 uppercase mb-2">Primeiro utilizador (escritório)</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            required
            value={officeName}
            onChange={(e) => setOfficeName(e.target.value)}
            placeholder="Nome"
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          />
          <input
            type="email"
            required
            value={officeEmail}
            onChange={(e) => setOfficeEmail(e.target.value)}
            placeholder="email@empresa.pt"
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          />
          <input
            type="password"
            required
            minLength={6}
            value={officePassword}
            onChange={(e) => setOfficePassword(e.target.value)}
            placeholder="Palavra-passe"
            className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded border border-red-800 bg-red-950 px-3 py-2 text-sm text-red-300">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="flex items-start gap-2 rounded border border-green-800 bg-green-950 px-3 py-2 text-sm text-green-300">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{success}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="flex items-center gap-1.5 rounded bg-amber-600 text-white text-sm font-medium px-4 py-2.5 hover:bg-amber-700 disabled:bg-zinc-700 disabled:cursor-not-allowed transition-colors"
      >
        <Plus className="w-4 h-4" />
        {submitting ? "A criar…" : "Criar empresa"}
      </button>
    </form>
  );
}
