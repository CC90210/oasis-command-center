/**
 * POST /api/bridge/pairing/revoke-self — a paired computer revokes its own
 * pairing (O3a). The connector calls this the moment the person it is
 * joining as declines the "Join OASIS as ..." prompt, so a redeemed code
 * never leaves a live, un-owned-by-the-declining-person token behind.
 *
 * Works for either pairing scope, and for a pairing that was never
 * approved (claim_enabled_at NULL) — revoking yourself is strictly safer
 * than any other state a pairing can be in, so this needs no extra gate
 * beyond proving you hold the current bearer.
 */
import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return bad(401, "unexpected_origin_header");
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const { pairing } = resolved;

  const nowIso = new Date().toISOString();
  const db = getServiceSupabase();
  const upd = await db
    .from("bridge_pairings")
    .update({ revoked_at: nowIso })
    .eq("id", pairing.pairingId)
    .is("revoked_at", null);
  if (upd.error) return bad(500, upd.error.message);

  return NextResponse.json({ ok: true, revoked_at: nowIso });
}
