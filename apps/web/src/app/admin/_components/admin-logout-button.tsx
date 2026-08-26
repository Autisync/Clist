"use client";

/*
 * Platform-admin logout — signs out of the real Supabase session directly
 * (unlike office's LogoutButton, there is no classic-system Fastify logout
 * route to also call; this surface has never been anything but
 * Supabase-native).
 */

import { useState } from "react";
import { LogOut } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function AdminLogoutButton() {
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await createSupabaseBrowserClient().auth.signOut();
    } finally {
      window.location.href = "/admin/login";
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
