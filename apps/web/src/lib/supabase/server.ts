import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAnonKey, supabaseUrl } from "./env";

/*
 * Server-side Supabase client — §6 Step 2. Mirrors why serverApiFetch exists
 * in ../api.ts: a Server Component's fetches don't automatically carry the
 * incoming request's cookies, so the session has to be read and forwarded
 * by hand via next/headers' cookies(), same reasoning, different mechanism
 * (Supabase's own session cookie instead of fr_session).
 *
 * setAll can throw when called from a Server Component (which cannot set
 * cookies) — that's expected and safe to swallow *only* once a middleware
 * is refreshing the Supabase session on every request; no such middleware
 * exists yet in this repo (deliberately not touched by this slice — see
 * apps/api/README.md's Supabase-native migration section) so until one is
 * added, a session nearing expiry inside a long-lived Server Component
 * render will not get silently refreshed here.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — see file comment above.
        }
      },
    },
  });
}
