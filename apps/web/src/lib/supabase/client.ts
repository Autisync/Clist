"use client";

/*
 * Browser-side Supabase client — §6 Step 2 (08-supabase-native-migration.md).
 * Only ever constructed with the anon key; RLS is what makes that safe to
 * ship at all (architecture note carried from the design doc's whole
 * premise — see schema.sql's header). Never import this from a Server
 * Component or route handler; use ./server.ts there instead, which forwards
 * the request's own cookies the same way apps/web/src/lib/api.ts's
 * serverApiFetch already has to for the existing Fastify-backed session.
 */

import { createBrowserClient } from "@supabase/ssr";
import { supabaseAnonKey, supabaseUrl } from "./env";

export function createSupabaseBrowserClient() {
  return createBrowserClient(supabaseUrl(), supabaseAnonKey());
}
