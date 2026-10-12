/**
 * POST /api/auth/pair-code
 *
 * Mints a one-time pair code that either `bravo setup` on a new machine
 * (purpose 'desktop', the Devices button, today's default) or the OASIS
 * Connector (purpose 'connector', Settings > Computers) redeems to bridge a
 * computer without copy-pasting tokens.
 *
 * Auth: session — only the logged-in dashboard user can issue codes for
 * their own tenant.
 *
 * Body (optional): { purpose?: "desktop" | "connector" }. Defaults to
 * "desktop" — every caller that predates this field keeps today's 15-minute,
 * sign-in-link-bearing code.
 *
 * SCOPE (O3a), decided at mint, never at redeem:
 *   - purpose 'connector' always yields scope 'connector' — the redeem
 *     answer mints no sign-in link, and the code lives 5 minutes, not 15.
 *   - purpose 'desktop' yields scope 'daemon' only when the minter is an
 *     owner or admin; everyone else minting a desktop code gets 'connector'.
 *     Before this, ANY member of a client workspace could mint a code whose
 *     resulting token could write any record and read every job with its
 *     payload (pair-code/route.ts:49 + cron-jobs/poll — O3a security rule 3).
 *
 * Returns:
 *   { ok: true, code: "ABC-DEF-GHJ", expires_at: "<iso8601>", purpose, scope }
 *
 * The code is shown to the user once (in the dashboard) and consumed once
 * (by the redeem endpoint). Single-use, short-lived. Stored plaintext in
 * the table because we have to look it up by code; the short window +
 * single-use semantics keep the leak window tight.
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad } from "@/lib/api-helpers";
import { resolveSessionContext } from "@/lib/api-auth";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CODE_TTL_MIN = 15;
const CONNECTOR_CODE_TTL_MIN = 5;
const PAIR_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}(?:-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{3}){2}$/;

// Alphabet excludes ambiguous chars (0/O, 1/I/L) so the operator can read
// it off the screen and type it without errors.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function mintCode(): string {
  // 9 chars in three triplets — easy to read aloud, ~46 bits of entropy.
  // randomBytes for unbiased selection.
  const buf = randomBytes(9);
  const chars: string[] = [];
  for (let i = 0; i < 9; i++) {
    chars.push(ALPHABET[buf[i] % ALPHABET.length]);
  }
  return `${chars.slice(0, 3).join("")}-${chars.slice(3, 6).join("")}-${chars.slice(6, 9).join("")}`;
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok || !session.email) return bad(401, "unauthorized");

  let body: { purpose?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const purpose = body.purpose === "connector" ? "connector" : "desktop";
  // A connector code can create only a connector-scoped pairing owned by the
  // signed-in member, so OASIS members may mint one for themselves. Desktop
  // codes can create a daemon-capable install and retain the stricter shared-
  // resource gate.
  if (purpose !== "connector" && !(await canAccessSharedTenantResource(session))) {
    return bad(403, "forbidden");
  }
  // Daemon scope is reserved for a desktop code minted by an owner or
  // admin — a connector code is always 'connector', by construction.
  const scope = purpose === "connector" ? "connector" : session.isAdmin ? "daemon" : "connector";
  const ttlMinutes = purpose === "connector" ? CONNECTOR_CODE_TTL_MIN : CODE_TTL_MIN;

  const db = getServiceSupabase();

  // Revoke any unconsumed prior codes from this user before minting a
  // fresh one. Without this, every "Generate code" click leaves the old
  // code valid until natural expiry and grows the active-code lookup set
  // unboundedly. Spec is "one live code per user at a time" — clicking
  // Generate is the explicit-revoke action for the previous. Codes that
  // have already been consumed are NOT touched (they're audit trail of
  // past pairings). Scoped to the same purpose: minting a connector code
  // must not silently burn a still-live desktop code and vice versa.
  await db
    .from("bridge_pair_codes")
    .delete()
    .eq("tenant_id", session.tenantId)
    .eq("auth_user_id", session.userId)
    .eq("purpose", purpose)
    .is("consumed_at", null);

  // Try a few times in case of unique-constraint collision (≈1 in 10^13).
  let code = "";
  let expiresAt = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    code = mintCode();
    expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    const ins = await db.from("bridge_pair_codes").insert({
      code,
      tenant_id: session.tenantId,
      auth_user_id: session.userId,
      email: session.email,
      expires_at: expiresAt,
      purpose,
      scope,
    });
    if (!ins.error) break;
    if (attempt === 3) {
      return bad(500, `mint_failed: ${ins.error.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    code,
    expires_at: expiresAt,
    ttl_minutes: ttlMinutes,
    purpose,
    scope,
  });
}

/**
 * Browser polling for the exact code it minted. This is the authoritative
 * completion signal for both a new pairing and a re-pair: re-pairing preserves
 * bridge_pairings.created_at, so time-based device discovery is not truthful.
 */
export async function GET(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const code = new URL(req.url).searchParams.get("code")?.trim().toUpperCase() ?? "";
  if (!PAIR_CODE_RE.test(code)) return bad(400, "invalid_code");

  const db = getServiceSupabase();
  const codeRead = await db
    .from("bridge_pair_codes")
    .select("expires_at, consumed_at, consumed_by_pairing_id")
    .eq("tenant_id", session.tenantId)
    .eq("auth_user_id", session.userId)
    .eq("purpose", "connector")
    .eq("code", code)
    .maybeSingle();
  if (codeRead.error) {
    console.error("[auth.pair-code.status.lookup]", {
      tenantId: session.tenantId,
      userId: session.userId,
      error: codeRead.error.message,
    });
    return bad(503, "pair_code_status_unavailable");
  }
  const row = codeRead.data as {
    expires_at?: string | null;
    consumed_at?: string | null;
    consumed_by_pairing_id?: string | null;
  } | null;
  if (!row) return bad(404, "code_not_found");
  if (!row.consumed_at || !row.consumed_by_pairing_id) {
    const expired = !row.expires_at || new Date(row.expires_at).getTime() < Date.now();
    return NextResponse.json({ ok: true, status: expired ? "expired" : "pending" });
  }

  const pairingRead = await db
    .from("bridge_pairings")
    .select("id, label, claim_enabled_at")
    .eq("tenant_id", session.tenantId)
    .eq("user_id", session.userId)
    .eq("id", row.consumed_by_pairing_id)
    .is("revoked_at", null)
    .maybeSingle();
  if (pairingRead.error) {
    console.error("[auth.pair-code.status.pairing]", {
      tenantId: session.tenantId,
      userId: session.userId,
      pairingId: row.consumed_by_pairing_id,
      error: pairingRead.error.message,
    });
    return bad(503, "paired_computer_status_unavailable");
  }
  if (!pairingRead.data) return bad(409, "paired_computer_unavailable");
  return NextResponse.json({ ok: true, status: "connected", pairing: pairingRead.data });
}
