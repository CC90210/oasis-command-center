/**
 * POST /api/auth/pair-code/redeem
 *
 * Called by `bravo setup` on a new machine after the operator pastes the
 * code shown by /settings → Devices → Generate code. Exchanges the code
 * for a bridge_pairings row + bearer token.
 *
 * Auth: code itself is the authentication. No session, no bearer secret.
 * The code is single-use and 15-min-lived (see migration 032 + the mint
 * endpoint at ../route.ts) so the leak window is intentionally tight.
 *
 * Body:
 *   { code: "ABC-DEF-GHJ", machine: { label?: string, fingerprint?: string } }
 *
 * Returns:
 *   {
 *     ok: true,
 *     tenant_id, profile_id, auth_user_id,
 *     bridge: { pairing_id, token, dashboard_url }
 *   }
 *
 * Error states:
 *   404 — unknown / expired / already-consumed code
 *   410 — code was already redeemed (different from 404 to make the CLI's
 *         error message clearer)
 *   500 — pairing insert failed (DB issue)
 */

import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad, sha256 } from "@/lib/api-helpers";
import {
  clientIp,
  isRateLimited,
  recordPairAttempt,
} from "@/lib/pair-rate-limit";
import { adminGetUser, mintSessionLinkToken } from "@/lib/turso-auth-admin";
import { tursoAuthActive } from "@/lib/turso-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidCodeShape(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(s);
}

export async function POST(req: NextRequest) {
  // Rate limit keyed on client IP. Pair-codes are 6 chars in XXX-XXX-XXX
  // form (10^9 search space, narrowed by single-use + 15-min TTL). Without
  // rate-limiting an attacker could enumerate from one IP. With it: 10
  // failed redeems per minute per IP, then 429. See pair_attempts CHECK
  // constraint for the full outcome vocabulary.
  const ip = clientIp(req);
  const rateKey = `redeem:${ip || "unknown"}`;

  if (await isRateLimited(rateKey)) {
    await recordPairAttempt(rateKey, "rate_limited", ip);
    return bad(429, "rate_limited: too many failed pair-code redemptions; back off and retry");
  }

  let body: { code?: unknown; machine?: { label?: unknown; fingerprint?: unknown } };
  try {
    body = await req.json();
  } catch {
    await recordPairAttempt(rateKey, "code_invalid_shape", ip);
    return bad(400, "invalid JSON");
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!isValidCodeShape(code)) {
    await recordPairAttempt(rateKey, "code_invalid_shape", ip);
    return bad(400, "invalid code shape (expect XXX-XXX-XXX)");
  }

  // Single-DB-side transaction via the redeem_pair_code RPC (migration 033).
  // Closes Codex's adversarial-review finding #1: the previous JS-side
  // claim-then-insert was vulnerable to client retries silently burning
  // the code (consumed flag flipped after the network failed mid-response,
  // plaintext token irretrievable). With the RPC, claim + insert + return
  // all happen in one transaction — either everything commits or
  // everything rolls back. The plaintext token never leaves the JS layer
  // until the row insert is durable.
  const machine = body.machine || {};
  const machineLabel = typeof machine.label === "string" ? machine.label.slice(0, 80) : "Local install";
  const machineFp = typeof machine.fingerprint === "string" ? machine.fingerprint.slice(0, 200) : null;

  const tokenPlain = `oab_${randomBytes(32).toString("hex")}`;
  const tokenHash = sha256(tokenPlain);

  const db = getServiceSupabase();
  const { data: rpcData, error: rpcError } = await db.rpc("redeem_pair_code", {
    p_code: code,
    p_token_hash: tokenHash,
    p_label: machineLabel,
    p_fingerprint: machineFp,
  });

  if (rpcError) {
    // PL/pgSQL raises map to specific HTTP codes. The RAISE EXCEPTION
    // statements use SQLSTATE codes P0001/P0002/P0003 plus the message
    // body 'PCODE_NOT_FOUND' / 'PCODE_CONSUMED' / 'PCODE_EXPIRED' so we
    // match on the message text (Supabase JS surfaces it as `message`).
    const msg = String(rpcError.message || "");
    if (msg.includes("PCODE_NOT_FOUND")) {
      await recordPairAttempt(rateKey, "code_not_found", ip);
      return bad(404, "code not found or expired");
    }
    if (msg.includes("PCODE_EXPIRED")) {
      await recordPairAttempt(rateKey, "code_expired", ip);
      return bad(404, "code not found or expired");
    }
    if (msg.includes("PCODE_CONSUMED")) {
      await recordPairAttempt(rateKey, "code_consumed", ip);
      return bad(410, "code already redeemed");
    }
    await recordPairAttempt(rateKey, "code_redeem_failed", ip);
    return bad(500, `redeem_failed: ${msg}`);
  }

  // RPC RETURNS TABLE returns an array even though we expect one row.
  const row =
    Array.isArray(rpcData) && rpcData.length > 0
      ? (rpcData[0] as {
          pairing_id: string;
          tenant_id: string;
          auth_user_id: string;
          profile_id: string | null;
        })
      : null;
  if (!row) {
    await recordPairAttempt(rateKey, "code_redeem_failed", ip);
    return bad(500, "redeem_returned_empty");
  }

  const baseUrl =
    process.env.BRAVO_DASHBOARD_URL ||
    "https://agent-dashboard-cc90210.vercel.app";

  // Log the successful redeem against the IP-keyed rate-limit row AND a
  // second row keyed on the resolved profile_id, so the pair endpoint's
  // rate-limit (which keys on profile_id) sees the success too.
  await recordPairAttempt(rateKey, "ok", ip);
  if (row.profile_id) {
    await recordPairAttempt(row.profile_id, "ok", ip);
  }

  // V0.1.0 alpha.5 — desktop sign-in is now turnkey via oasis:// deep-link.
  // After the redeem succeeds, we ALSO mint a one-time sign-in link the
  // desktop will load in its main Electron window. Loading that link sets
  // the session cookie on the Electron browser's domain so the user is
  // already signed in when the dashboard renders — no second sign-in step
  // inside the Electron view. The pair-code was already the authentication;
  // the link just transports the session into the desktop's cookie jar.
  //
  // Under Turso auth the link is ours: a single-use _auth_tokens row redeemed
  // at /auth/turso-session, 15-min TTL (tighter than Supabase's 1-hour
  // magic-link default, and matched to the pair-code that minted it).
  // auth.admin.generateLink is GoTrue and dies with the Supabase project, so
  // on that path the desktop would silently lose turnkey sign-in forever.
  //
  // The response field stays `magic_link_url` — the desktop client reads that
  // key, and renaming it would break pairing on every already-shipped build.
  let magicLinkUrl: string | null = null;
  try {
    const emailLookup = await adminGetUser(db, row.auth_user_id);
    if (!emailLookup.ok) throw new Error(emailLookup.error);
    const email = emailLookup.value.email;
    if (email) {
      if (tursoAuthActive()) {
        const linkToken = await mintSessionLinkToken(email);
        magicLinkUrl =
          `${baseUrl.replace(/\/$/, "")}/auth/turso-session` +
          `?token=${encodeURIComponent(linkToken)}&next=${encodeURIComponent("/")}`;
      } else {
        const callbackUrl = `${baseUrl.replace(/\/$/, "")}/auth/callback?next=/`;
        const linkRes = await db.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: { redirectTo: callbackUrl },
        });
        magicLinkUrl = linkRes.data?.properties?.action_link || null;
      }
    }
  } catch (linkErr) {
    // Sign-in-link minting must never block pairing: the pairing token above
    // is already durable and is the thing the CLI actually needs. If this
    // fails the desktop falls back to "open Command Center in browser" —
    // degraded UX, working pairing.
    //
    // But it is LOGGED, not swallowed. The previous empty catch turned a
    // broken auth backend into an invisible UX regression: every desktop
    // install silently lost turnkey sign-in with nothing in the logs to say
    // why. `session: null` in the response is the client-visible signal.
    console.error(
      "[pair-code/redeem] sign-in link minting failed (pairing itself succeeded):",
      linkErr instanceof Error ? linkErr.message : linkErr,
    );
    magicLinkUrl = null;
  }

  return NextResponse.json({
    ok: true,
    tenant_id: row.tenant_id,
    profile_id: row.profile_id,
    auth_user_id: row.auth_user_id,
    bridge: {
      pairing_id: row.pairing_id,
      token: tokenPlain,
      dashboard_url: baseUrl.replace(/\/$/, "") + "/",
    },
    session: magicLinkUrl ? { magic_link_url: magicLinkUrl } : null,
  });
}
