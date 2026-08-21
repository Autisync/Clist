/*
 * Shared env-var access for both Supabase client factories below.
 *
 * NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are safe to ship
 * to the browser (that's what "anon" means, and what NEXT_PUBLIC_ means) —
 * 08-supabase-native-migration.md §7 is explicit that these still come from
 * a local, gitignored .env file, never hardcoded into a committed file. See
 * apps/web/.env.example for the variable names (no values).
 *
 * Throws loudly rather than constructing a client against `undefined` — a
 * client-that-silently-can't-reach-Supabase is a much worse failure mode
 * than an explicit startup error, especially once RLS is the only boundary
 * and a misconfigured client could otherwise look like "no data" instead of
 * "not configured."
 */

export function supabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is not set. Add it to apps/web/.env.local ' +
      '(see .env.example) — this is the §6 Step 2 Supabase-native slice, ' +
      'not required for the existing Fastify-backed app.'
    );
  }
  return url;
}

export function supabaseAnonKey(): string {
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Add it to apps/web/.env.local ' +
      '(see .env.example) — this is the §6 Step 2 Supabase-native slice, ' +
      'not required for the existing Fastify-backed app.'
    );
  }
  return key;
}
