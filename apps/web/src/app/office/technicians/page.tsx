/*
 * Technicians — device pairing, rebuilt for real (technician-auth
 * migration, 08-supabase-native-migration.md §2). Replaces the old Phase 1
 * "paste your own app_user.id as an inviteToken" hack entirely — that
 * design assumed no way to resolve the calling office user's identity
 * server-side; the Supabase-native cutover made that resolution real
 * (fn_current_app_user_id()), so there's no reason left to ask the office
 * user to paste anything. Only wired in now, not when the backend
 * (rpc_technician_create, routes/technicians.ts) first landed — flipping
 * this UI before /field/login and every field page could also read/write
 * Supabase-native data would have let the office create technicians who
 * could never actually log in (apps/api/README.md's Supabase-native
 * section has the full history of that sequencing call).
 *
 * Split the same way suppliers/page.tsx is: the initial technician +
 * device list comes straight from Supabase (RLS-scoped, real `.from()`
 * reads, no new backend needed for this half); creating a technician
 * (rpc_technician_create) and pairing/revoking a device
 * (POST /technicians/:id/pair, POST /technicians/devices/:id/revoke —
 * apps/api/src/routes/technicians.ts, still Fastify-backed because both
 * need the service_role Admin API to create/ban a Supabase Auth user, which
 * no RPC can reach) live in the client component below.
 */

import { Smartphone } from "lucide-react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TechniciansClient } from "./_components/technicians-client";

export default async function TechniciansPage() {
  const supabase = await createSupabaseServerClient();
  const [{ data: technicians, error: techError }, { data: devices, error: deviceError }] = await Promise.all([
    supabase
      .from("app_user")
      .select("id, full_name, phone, active")
      .eq("role", "technician")
      .order("full_name", { ascending: true }),
    supabase
      .from("technician_device")
      .select("id, user_id, device_label, paired_at, revoked_at, last_seen_at")
      .order("paired_at", { ascending: false }),
  ]);
  if (techError) throw techError;
  if (deviceError) throw deviceError;

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2">
        <Smartphone className="w-5 h-5 text-cyan-600" />
        <h1 className="text-lg font-semibold text-zinc-900">Técnicos</h1>
      </div>
      <p className="text-sm text-zinc-500 mt-1">
        Crie técnicos e emparelhe os telemóveis usados no terreno.
      </p>

      <TechniciansClient initialTechnicians={technicians ?? []} initialDevices={devices ?? []} />
    </div>
  );
}
