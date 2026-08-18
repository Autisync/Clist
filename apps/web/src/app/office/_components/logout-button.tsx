"use client";

/*
 * Small client island for the office header — the rest of OfficeLayout is
 * a Server Component, so the interactive logout control lives in its own
 * file per the standard App Router pattern (Server Component parent,
 * Client Component leaf) rather than converting the whole layout.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { apiFetch } from "@/lib/api";

export function LogoutButton() {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await apiFetch("/auth/office/logout", { method: "POST" });
    } catch {
      // Even if the request fails (e.g. session already expired server-
      // side), still send the user to /login — there's nothing useful to
      // recover here and staying on a stale page is worse.
    } finally {
      router.push("/login");
    }
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loggingOut}
      className="flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-50 whitespace-nowrap"
    >
      <LogOut className="w-4 h-4" />
      {loggingOut ? "A sair…" : "Sair"}
    </button>
  );
}
