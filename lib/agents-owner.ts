/**
 * lib/agents-owner.ts - who a workspace's AGENTS OWNER is: the one auth user
 * whose computer that workspace's department chats and bridge tools may
 * reach (O1, database/turso/bravo__210_workspace_agents_owner.sql).
 *
 * WHY ITS OWN MODULE. lib/bridge-proxy.ts authorizeBridgeRequest is the single
 * gate every bridge-reaching route shares (chat, exec-tool, health, prewarm,
 * warm-status, actions, cli-auth, chat-reset, background-workers/control,
 * leads/[id]/clair-report); lib/ai/bridge-turn.ts and the background-workers
 * control route need the same answer for the SAME reason (routing to a
 * person's computer, and attributing a control action to the right side).
 * One read, one set of outcomes, used everywhere a "whose computer is this"
 * question is asked.
 *
 * Fails CLOSED and names the SHAPE of the failure, because the three outcomes
 * mean different things to a caller deciding whether to answer, refuse, or
 * fall back to a key:
 *   "set"         - a live, unrevoked row: authUserId is the owner.
 *   "not_set"     - no row for this tenant, or the only row is revoked:
 *                   nobody is the owner yet, and nobody may be routed to a
 *                   key in the (absent) owner's place.
 *   "unavailable" - the read itself failed: a database fault, never read as
 *                   "not_set" (which would wrongly look like "nobody owns
 *                   this yet, pick a safe default") and never as permission.
 *
 * No route writes workspace_agents_owner. Rows are inserted and revoked by
 * hand, by an operator with direct database access; a revocation sets
 * revoked_at rather than deleting the row, so the history survives — and
 * reads here as "not_set" (dbBool is not needed: revoked_at is a presence
 * check, not a 0/1 column).
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";

export type AgentsOwnerLookup = { state: "set"; authUserId: string } | { state: "not_set" } | { state: "unavailable" };

type OwnerRow = { auth_user_id?: string | null; revoked_at?: string | null };

/**
 * The workspace's agents-owner row, ignoring a revoked one. See the module
 * doc for why each outcome is kept distinct instead of collapsing to a
 * boolean. Never throws: a read error is logged and answered "unavailable".
 */
export async function readAgentsOwner(tenantId: string): Promise<AgentsOwnerLookup> {
  try {
    const svc = getServiceSupabase();
    const { data, error } = await svc
      .from("workspace_agents_owner")
      .select("auth_user_id, revoked_at")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const row = data as OwnerRow | null;
    const authUserId = row?.auth_user_id ? String(row.auth_user_id).trim() : "";
    if (!authUserId || row?.revoked_at) return { state: "not_set" };
    return { state: "set", authUserId };
  } catch (err) {
    console.error("[agents-owner.read]", { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { state: "unavailable" };
  }
}

/**
 * True only when `authUserId` is this tenant's LIVE, unrevoked agents owner.
 * Fails CLOSED: no session id, no row, a revoked row, or a read error are all
 * "no" — never "yes" by default. Used where a caller only needs the boolean
 * (e.g. background-workers/control's actor-side attribution); a caller that
 * must distinguish "not set" from "unavailable" (the bridge gate) reads
 * readAgentsOwner directly.
 */
export async function isAgentsOwner(tenantId: string, authUserId: string | null | undefined): Promise<boolean> {
  if (!authUserId) return false;
  const owner = await readAgentsOwner(tenantId);
  return owner.state === "set" && owner.authUserId === authUserId;
}
