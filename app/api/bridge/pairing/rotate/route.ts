/**
 * POST /api/bridge/pairing/rotate — a paired computer rotates its own
 * bearer token (O3a). The connector rotates at start and weekly
 * (cli_design.json computer_runner). Works for either pairing scope.
 *
 * The prior token keeps answering for TOKEN_ROTATION_GRACE_MS (60 s) —
 * resolvePairingFromBearer's reuse-after-rotation check — so a computer
 * mid-flight on the old value is not cut off mid-request. Using it again
 * after the grace revokes the pairing.
 *
 * This route is under the public /api/bridge path (middleware.ts); it
 * authenticates itself with the bearer, never a session cookie, and never
 * trusts an Origin header.
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { bad, sha256 } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolvePairingFromBearer } from "@/lib/bridge/pairing-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.headers.get("origin")) return bad(401, "unexpected_origin_header");
  const resolved = await resolvePairingFromBearer(req);
  if (!resolved.ok) return bad(resolved.status, resolved.error);
  const { pairing } = resolved;

  const newTokenPlain = `oab_${randomBytes(32).toString("hex")}`;
  const newHash = sha256(newTokenPlain);
  const nowIso = new Date().toISOString();

  const db = getServiceSupabase();
  // CAS on the token this call actually authenticated with — if another
  // rotate (or a redeem that replaced this fingerprint) already moved the
  // hash, 0 rows match and the caller is told to re-authenticate rather
  // than silently clobbering a newer token.
  const upd = await db
    .from("bridge_pairings")
    .update({
      bridge_token_hash: newHash,
      previous_token_hash: pairing.tokenHash,
      token_rotated_at: nowIso,
    })
    .eq("id", pairing.pairingId)
    .eq("bridge_token_hash", pairing.tokenHash)
    .is("revoked_at", null)
    .select("id");
  if (upd.error) return bad(500, upd.error.message);
  if (!upd.data || upd.data.length !== 1) {
    return bad(409, "rotate_conflict: the token was already rotated by another call");
  }

  return NextResponse.json({ ok: true, token: newTokenPlain, rotated_at: nowIso });
}
