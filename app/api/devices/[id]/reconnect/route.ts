/**
 * POST /api/devices/[id]/reconnect - ask one of your own computers to reconnect.
 *
 * Refresh in Settings > Devices calls this for each of the person's computers
 * that reads Offline (CC, 2026-10-27). It records the request; the computer's
 * next check-in (POST /api/bridge/ping, about a minute) answers reconnect: true
 * and its bridge starts fresh (lib/devices/reconnect.ts).
 *
 * The owner's own session only, like approve: a teammate or an admin cannot
 * restart someone else's computer. A disconnected computer cannot reconnect
 * (409): it is connected again with a new code.
 */
import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { resolveSessionContext } from "@/lib/api-auth";
import { requestReconnect } from "@/lib/devices/reconnect";
import { getServiceSupabase } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const { id } = await ctx.params;
  if (!id) return bad(400, "id required");

  const row = await getServiceSupabase()
    .from("bridge_pairings")
    .select("id, user_id, revoked_at")
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (row.error) return bad(500, row.error.message);
  if (!row.data) return bad(404, "pairing_not_found");
  const pairing = row.data as { id: string; user_id: string | null; revoked_at: string | null };
  if (pairing.revoked_at) return bad(409, "pairing_revoked");
  if (!pairing.user_id || pairing.user_id !== session.userId) return bad(403, "not_your_computer");

  const saved = await requestReconnect({ tenantId: session.tenantId, pairingId: pairing.id, requestedBy: session.profileId ?? null });
  if (!saved.ok) {
    console.error("[devices.reconnect] request not saved", { tenantId: session.tenantId, pairingId: pairing.id, error: saved.error });
    return bad(500, "reconnect_not_saved");
  }
  return NextResponse.json({ ok: true, requested_at: saved.requestedAt });
}
