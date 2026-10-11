/**
 * POST /api/bridge/pairing/rotate — a paired computer rotates its own
 * bearer token (O3a). The connector rotates at start and weekly
 * (cli_design.json computer_runner). Works for either pairing scope.
 *
 * The prior token keeps answering PING/POLL/etc for TOKEN_ROTATION_GRACE_MS
 * (60 s) — resolvePairingFromBearer's reuse-after-rotation check — so a
 * computer mid-flight on the old value is not cut off mid-request. Using it
 * again after the grace revokes the pairing.
 *
 * Rotating ITSELF is narrower: only the CURRENT token may rotate. The CAS
 * below is keyed on `presentedTokenHash` (what this request's bearer
 * actually hashes to), never `pairing.tokenHash` (the row's live hash,
 * which resolvePairingFromBearer returns even when the match came through
 * the prior-in-grace path). Keying on the live hash let a holder of the
 * already-replaced token call rotate during the grace and mint ANOTHER
 * fresh token from a credential that should have been spent (found in
 * review: two sequential rotate calls with the same stale bearer both
 * returned 200). Keying on what was presented makes that CAS match zero
 * rows for a stale bearer, so it is refused with the same 409 a genuine
 * race gets — one UPDATE ... RETURNING decides both cases.
 *
 * This route is under the public /api/bridge path (middleware.ts); it
 * authenticates itself with the bearer, never a session cookie, and never
 * trusts an Origin header. The new token is returned once, in the body —
 * never logged.
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
  // CAS on the hash of the bearer THIS REQUEST presented — see the module
  // doc. If another rotate already moved it (a real race), or this call
  // presented the prior, already-superseded token, 0 rows match and the
  // caller is refused rather than silently handed a second fresh token.
  const upd = await db
    .from("bridge_pairings")
    .update({
      bridge_token_hash: newHash,
      previous_token_hash: pairing.presentedTokenHash,
      token_rotated_at: nowIso,
    })
    .eq("id", pairing.pairingId)
    .eq("bridge_token_hash", pairing.presentedTokenHash)
    .is("revoked_at", null)
    .select("id");
  if (upd.error) return bad(500, upd.error.message);
  if (!upd.data || upd.data.length !== 1) {
    return bad(409, "rotate_conflict: only the current token may rotate; re-authenticate and retry");
  }

  return NextResponse.json({ ok: true, token: newTokenPlain, rotated_at: nowIso });
}
