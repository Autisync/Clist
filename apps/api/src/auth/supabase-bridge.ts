// Bridge auth — lets a caller with ONLY a real Supabase session (no
// fr_session cookie at all) reach the handful of routes that are still
// Fastify-only: photo upload, receipt upload/confirm, refresh-places, and
// technician device pairing/creation/revocation (auth/tokens.ts's own
// SESSION_JWT_SECRET-signed cookie has no equivalent on the Supabase side).
//
// Real, previously-invisible gap this closes: apps/web's office `/login`
// page (§6 Step 5) signs in via real Supabase Auth only — it never sets
// fr_session at all — so any real production office user hitting one of
// the routes above via requireAuth got a hard 401, silently, since nothing
// in this app's own test suites exercises a Supabase-session-only caller
// against a still-Fastify route (smoke.mjs's own comment already admits its
// session is synthetic, never a real Supabase one). Found by tracing
// apiFetch -> requireAuth -> fr_session cookie end to end while designing
// the technician-auth migration below, not by a report.
//
// Design: verify the bearer token against Supabase's own Auth API (GET
// /auth/v1/user) rather than duplicating JWT-secret verification here --
// one extra network hop per call, acceptable for these low-frequency,
// office/technician-initiated actions (never a hot path), and it means this
// file never needs to know Supabase's signing key at all, only the two
// values apps/api already requires (SUPABASE_PROJECT_REF, SUPABASE_ANON_KEY).
// Then resolve identity through public.app_user / public.technician_device
// using the SAME trusted, RLS-bypassing connection (withMigrator) the
// classic system's own login handlers already use for exactly this kind of
// pre-tenant-context lookup -- not a new privilege, the one this codebase
// already documents as intentionally elevated.
//
// Office/owner rows: app_user.auth_user_id is set directly (§6 Step 1
// schema.sql's own comment: "Office/owner rows only"). Technician rows:
// app_user.auth_user_id is always null by design ("technician rows...have
// no login of their own, ever") -- the auth link lives on
// technician_device.auth_user_id instead, one row per PAIRED DEVICE, not
// per technician-person. Both paths mirror fn_current_tenant_id()/
// fn_current_app_user_id()'s own resolution logic exactly (schema.sql) --
// this is the same identity model, just resolved from Fastify instead of
// inside Postgres, for the one class of route that isn't a Supabase RPC/
// PostgREST call at all.

import type { SessionClaims } from "@fieldready/core";
import { withMigrator } from "../db.js";

async function verifySupabaseUserId(bearerToken: string): Promise<string | null> {
  const projectRef = process.env.SUPABASE_PROJECT_REF;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!projectRef || !anonKey) return null;

  const res = await fetch(`https://${projectRef}.supabase.co/auth/v1/user`, {
    headers: { Authorization: `Bearer ${bearerToken}`, apikey: anonKey },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { id?: string };
  return body.id ?? null;
}

export async function resolveSupabaseClaims(bearerToken: string): Promise<SessionClaims | null> {
  const supabaseUserId = await verifySupabaseUserId(bearerToken);
  if (!supabaseUserId) return null;

  return withMigrator(async (db) => {
    // Office/owner path first — app_user.auth_user_id set directly.
    const office = await db.query<{ id: string; tenant_id: string; role: string }>(
      `select id, tenant_id, role from public.app_user
       where auth_user_id = $1 and active;`,
      [supabaseUserId]
    );
    if (office.rows.length > 0) {
      const row = office.rows[0];
      return { tenant_id: row.tenant_id, user_id: row.id, role: row.role as "owner" | "office" };
    }

    // Technician/device path — auth_user_id lives on technician_device, not
    // app_user. revoked_at is re-checked here on every call, not just at
    // sign-in, same defense-in-depth reasoning 08-supabase-native-
    // migration.md §2 gives for why RLS itself also re-checks this (a
    // still-unexpired Supabase access token issued before revocation must
    // not keep working).
    const device = await db.query<{ device_id: string; user_id: string; tenant_id: string }>(
      `select td.id as device_id, td.user_id, td.tenant_id
       from public.technician_device td
       where td.auth_user_id = $1 and td.revoked_at is null;`,
      [supabaseUserId]
    );
    if (device.rows.length > 0) {
      const row = device.rows[0];
      return { tenant_id: row.tenant_id, user_id: row.user_id, role: "technician", device_id: row.device_id };
    }

    return null;
  });
}
