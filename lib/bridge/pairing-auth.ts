/**
 * lib/bridge/pairing-auth.ts — resolvePairingFromBearer: the ONE bearer-auth
 * check for every machine route under /api/bridge and /api/cron-jobs/poll
 * that answers a paired computer (O3a). Before this, ping, poll and records
 * each carried their own copy of "hash the bearer, look up bridge_pairings,
 * reject a revoked row" (app/api/bridge/ping/route.ts,
 * app/api/cron-jobs/poll/route.ts, app/api/bridge/records/[entity]/route.ts).
 * Three copies meant three places a fix could land in two of them.
 *
 * SCOPE. A pairing's scope decides what it may do (O3a security rule 3):
 *   'connector' — ping, claim, canary, rotate, events only.
 *   'daemon'    — everything 'connector' can, plus cron polling and record
 *                 writes.
 * A row with scope NULL predates this column and reads as 'daemon' — CCPC
 * and CC's Mac, the only three live pairings as of this migration, keep
 * working with zero re-approval (O3a legacy-compatibility requirement).
 *
 * REUSE-AFTER-ROTATION. A rotated token's PRIOR hash still answers for 60
 * seconds (the rotating computer may not have the new one yet). Past that
 * grace, using the old token again means a copy of it leaked or the
 * computer never picked up the new one — either way the pairing is revoked
 * and an attention item is raised, never silently accepted.
 */
import "server-only";
import type { NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sha256 } from "@/lib/api-helpers";

export type PairingScope = "connector" | "daemon";
export type PairedVia = "pair_code" | "hmac" | "signup_secret" | null;

export type ResolvedPairing = {
  pairingId: string;
  tenantId: string;
  userId: string | null;
  label: string;
  /** NULL on a legacy row reads as 'daemon' — see module doc. */
  scope: PairingScope;
  pairedVia: PairedVia;
  claimEnabledAt: string | null;
  claimEnabledBy: string | null;
  /** The row's CURRENT bearer hash as stored right now. Do NOT use this for
   *  a rotate CAS: during the 60s grace this resolves via the PRIOR hash, so
   *  `tokenHash` here is the row's live value, not what the caller sent —
   *  CAS-ing against it would let a stale, already-replaced token rotate
   *  again. Use `presentedTokenHash` for that. */
  tokenHash: string;
  /** sha256 of the bearer the caller ACTUALLY sent, whichever of the two
   *  hashes (current or prior-in-grace) it matched. The one safe value for
   *  a rotate's compare-and-swap: a stale token never matches the row's
   *  live hash, so a second rotation off it affects zero rows. */
  presentedTokenHash: string;
};

export type PairingRefusal =
  | { ok: false; status: 401; error: "missing_bearer" }
  | { ok: false; status: 401; error: "unknown_token" }
  | { ok: false; status: 403; error: "pairing_revoked" }
  | { ok: false; status: 403; error: "token_reused_after_rotation" };

/** A replaced token used again, outside the grace window, still answers for
 *  this: 60 s covers a computer that rotated and is a couple of requests
 *  behind picking up the new value, never a copy kept around for later. */
export const TOKEN_ROTATION_GRACE_MS = 60_000;

const PAIRING_COLUMNS =
  "id, tenant_id, user_id, label, revoked_at, scope, paired_via, claim_enabled_at, claim_enabled_by, bridge_token_hash";

type PairingRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  label: string | null;
  revoked_at: string | null;
  scope: string | null;
  paired_via: string | null;
  claim_enabled_at: string | null;
  claim_enabled_by: string | null;
  bridge_token_hash: string;
  token_rotated_at?: string | null;
};

function normalizeScope(raw: unknown): PairingScope {
  return raw === "connector" ? "connector" : "daemon";
}

function normalizePairedVia(raw: unknown): PairedVia {
  return raw === "pair_code" || raw === "hmac" || raw === "signup_secret" ? raw : null;
}

function toResolved(row: PairingRow, presentedTokenHash: string): ResolvedPairing {
  return {
    pairingId: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    label: row.label || "",
    scope: normalizeScope(row.scope),
    pairedVia: normalizePairedVia(row.paired_via),
    claimEnabledAt: row.claim_enabled_at,
    claimEnabledBy: row.claim_enabled_by,
    tokenHash: row.bridge_token_hash,
    presentedTokenHash,
  };
}

/** Best-effort: a replaced key being reused is surfaced, never allowed to
 *  block the refusal itself if the write fails. */
async function raiseReusedTokenAttention(
  db: ReturnType<typeof getServiceSupabase>,
  row: { id: string; tenant_id: string; label: string | null },
): Promise<void> {
  try {
    const r = await db.from("agent_events").insert({
      event_type: "pairing_token_reused",
      publisher_agent: "bridge-pairing",
      severity: "warn",
      payload: {
        pairing_id: row.id,
        label: row.label || "",
        message: "A replaced pairing token was reused after its 60-second rotation grace. The computer was revoked.",
      },
      correlation_id: row.tenant_id,
    });
    if (r.error) console.error("[bridge.pairing-auth] attention write failed", r.error.message);
  } catch (err) {
    console.error("[bridge.pairing-auth] attention write threw", err instanceof Error ? err.message : String(err));
  }
}

export async function resolvePairingFromBearer(
  req: NextRequest,
): Promise<{ ok: true; pairing: ResolvedPairing } | PairingRefusal> {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return { ok: false, status: 401, error: "missing_bearer" };
  const tokenPlain = auth.slice(7).trim();
  if (!tokenPlain) return { ok: false, status: 401, error: "missing_bearer" };
  const tokenHash = sha256(tokenPlain);

  const db = getServiceSupabase();

  const current = await db
    .from("bridge_pairings")
    .select(PAIRING_COLUMNS)
    .eq("bridge_token_hash", tokenHash)
    .maybeSingle();
  if (current.error) {
    console.error("[bridge.pairing-auth] lookup failed", current.error.message);
    return { ok: false, status: 401, error: "unknown_token" };
  }
  if (current.data) {
    const row = current.data as PairingRow;
    // Known-but-revoked is distinct from unknown (401): the pairing proves
    // who the token belonged to, it just no longer may act — ping, poll and
    // records all answered 403 for this before resolvePairingFromBearer
    // unified them, and that distinction is load-bearing for their callers.
    if (row.revoked_at) return { ok: false, status: 403, error: "pairing_revoked" };
    return { ok: true, pairing: toResolved(row, tokenHash) };
  }

  // Not the live token. It may be the PRIOR one, still inside its rotation
  // grace, or a replayed one past it.
  const prior = await db
    .from("bridge_pairings")
    .select(`${PAIRING_COLUMNS}, token_rotated_at`)
    .eq("previous_token_hash", tokenHash)
    .maybeSingle();
  if (prior.error || !prior.data) return { ok: false, status: 401, error: "unknown_token" };
  const priorRow = prior.data as PairingRow;
  if (priorRow.revoked_at) return { ok: false, status: 403, error: "pairing_revoked" };

  const rotatedAtMs = Date.parse(String(priorRow.token_rotated_at || ""));
  const withinGrace = Number.isFinite(rotatedAtMs) && Date.now() - rotatedAtMs <= TOKEN_ROTATION_GRACE_MS;
  if (withinGrace) return { ok: true, pairing: toResolved(priorRow, tokenHash) };

  const nowIso = new Date().toISOString();
  const revoke = await db.from("bridge_pairings").update({ revoked_at: nowIso }).eq("id", priorRow.id).is("revoked_at", null);
  if (revoke.error) console.error("[bridge.pairing-auth] revoke-on-reuse failed", revoke.error.message);
  await raiseReusedTokenAttention(db, priorRow);
  return { ok: false, status: 403, error: "token_reused_after_rotation" };
}

export function isDaemonScope(pairing: Pick<ResolvedPairing, "scope">): boolean {
  return pairing.scope === "daemon";
}

/**
 * The gate O4's claim route enforces in full (plus seat liveness and
 * agents-owner ownership for a daemon pairing); exported here, as a pure
 * predicate over the two facts this slice already stores, so a pairing that
 * is not yet approved — or can never be — reads as "cannot claim" before the
 * claim route itself exists.
 */
export function pairingCanClaim(pairing: Pick<ResolvedPairing, "claimEnabledAt" | "pairedVia">): boolean {
  return pairing.pairedVia !== "signup_secret" && Boolean(pairing.claimEnabledAt);
}
