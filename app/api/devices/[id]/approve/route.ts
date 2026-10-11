/**
 * POST /api/devices/[id]/approve — approve a paired computer for work (O3a).
 *
 * A computer takes work only after ITS OWNER approves it in a signed-in
 * session: this stamps bridge_pairings.claim_enabled_at / claim_enabled_by,
 * which O4's claim route reads (lib/bridge/pairing-auth.ts pairingCanClaim).
 *
 * WHO CAN APPROVE WHAT (O3a security rule 2):
 *   - Only the pairing's OWNER (bridge_pairings.user_id === the signed-in
 *     auth user) may approve it — not an admin, not anyone else in the
 *     workspace. "Approval by anyone but the owner" is refused, even for an
 *     owner/admin team role: team-level admin power over the workspace is
 *     not the same thing as holding the computer.
 *   - A 'daemon'-scope pairing may be approved ONLY when its owner is this
 *     workspace's AGENTS OWNER (lib/agents-owner.ts isAgentsOwner) — this is
 *     how CCPC and CC's Mac get approved, and how everyone else's daemon-
 *     scope pairing (which should not exist going forward, but a legacy
 *     HMAC row might) stays unapprovable.
 *   - A 'signup_secret' pairing can NEVER be approved — it proves nobody's
 *     identity (O0), so there is no owner whose approval would mean anything.
 *   - A pairing with no recorded owner (legacy, user_id NULL) can never be
 *     approved either: there is nobody to approve it as.
 *
 * CLAUDE ACCOUNT (optional). Body may carry claude_account_hash
 * (sha256(orgId), 64 lowercase hex chars). Approval records it. A hash
 * already approved for another ACTIVE person in the same workspace is
 * refused (409 claude_account_shared) — two people sharing one Claude
 * sign-in is not "their own subscription".
 */
import { NextResponse, type NextRequest } from "next/server";
import { bad } from "@/lib/api-helpers";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isAgentsOwner } from "@/lib/agents-owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAUDE_HASH_RE = /^[0-9a-f]{64}$/;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return bad(401, "unauthorized");
  const { id } = await ctx.params;
  if (!id) return bad(400, "id required");

  let body: { claude_account_hash?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const claudeHash =
    typeof body.claude_account_hash === "string" && CLAUDE_HASH_RE.test(body.claude_account_hash.toLowerCase())
      ? body.claude_account_hash.toLowerCase()
      : null;

  const db = getServiceSupabase();
  const row = await db
    .from("bridge_pairings")
    .select("id, tenant_id, user_id, label, scope, paired_via, revoked_at, claim_enabled_at")
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .maybeSingle();
  if (row.error) return bad(500, row.error.message);
  if (!row.data) return bad(404, "pairing_not_found");
  const pairing = row.data as {
    id: string;
    tenant_id: string;
    user_id: string | null;
    label: string | null;
    scope: string | null;
    paired_via: string | null;
    revoked_at: string | null;
  };

  if (pairing.revoked_at) return bad(409, "pairing_revoked");
  if (!pairing.user_id) return bad(409, "pairing_has_no_owner");
  // The owner's OWN session only. Team-admin power does not reach here.
  if (pairing.user_id !== session.userId) return bad(403, "not_your_computer");
  if (pairing.paired_via === "signup_secret") {
    return bad(403, "signup_secret_pairing_cannot_be_approved");
  }
  const scope = pairing.scope === "connector" ? "connector" : "daemon"; // legacy NULL -> daemon
  if (scope === "daemon") {
    const ownerOk = await isAgentsOwner(session.tenantId, pairing.user_id);
    if (!ownerOk) return bad(403, "daemon_pairing_requires_agents_owner");
  }

  if (claudeHash) {
    const sameHash = await db
      .from("bridge_pairings")
      .select("id, user_id, claim_enabled_at")
      .eq("tenant_id", session.tenantId)
      .eq("claude_account_hash", claudeHash)
      .is("revoked_at", null);
    if (sameHash.error) return bad(500, sameHash.error.message);
    const sharedWithSomeoneElse = ((sameHash.data || []) as Array<{ id: string; user_id: string | null; claim_enabled_at: string | null }>).some(
      (r) => r.id !== pairing.id && r.user_id && r.user_id !== pairing.user_id && r.claim_enabled_at,
    );
    if (sharedWithSomeoneElse) return bad(409, "claude_account_shared");
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    claim_enabled_at: nowIso,
    claim_enabled_by: session.userId,
  };
  if (claudeHash) update.claude_account_hash = claudeHash;

  const upd = await db
    .from("bridge_pairings")
    .update(update)
    .eq("id", id)
    .eq("tenant_id", session.tenantId)
    .is("revoked_at", null);
  if (upd.error) return bad(500, upd.error.message);

  return NextResponse.json({ ok: true, claim_enabled_at: nowIso, scope });
}
