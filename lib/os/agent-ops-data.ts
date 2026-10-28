/**
 * lib/os/agent-ops-data.ts - the one read Admin > Agent ops makes besides the notes themselves (2026-10-28):
 * which computer delivers directives, when it last checked in, and whether its bridge runs the relay.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { readAgentsOwner } from "@/lib/agents-owner";
import { AGENT_INBOX_PROTOCOL } from "@/lib/agent-inbox-types";
import type { DeliveryComputer } from "@/lib/os/agent-ops";

type PairingRow = {
  label: string | null;
  last_seen_at: string | null;
  claim_protocols: unknown;
  claim_enabled_at: string | null;
  paired_via: string | null;
};

function advertisesRelay(raw: unknown): boolean {
  try {
    const protocols = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(protocols) && protocols.includes(AGENT_INBOX_PROTOCOL);
  } catch {
    return false;
  }
}

/**
 * The agents owner's computer that delivers directives: of their approved,
 * unrevoked pairings, the most recently seen one that runs the relay, else the
 * most recently seen one. Null when the workspace has no agents owner or no
 * approved computer. THROWS when either read fails: the page says it could not
 * check, never "no computer".
 */
export async function readDeliveryComputer(tenantId: string): Promise<DeliveryComputer | null> {
  const owner = await readAgentsOwner(tenantId);
  if (owner.state === "unavailable") throw new Error("agent-ops: agents owner read failed");
  if (owner.state !== "set") return null;
  const { data, error } = await getServiceSupabase()
    .from("bridge_pairings")
    .select("label, last_seen_at, claim_protocols, claim_enabled_at, paired_via")
    .eq("tenant_id", tenantId)
    .eq("user_id", owner.authUserId)
    .is("revoked_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`agent-ops: bridge_pairings read failed: ${error.message}`);
  const approved = ((data || []) as PairingRow[]).filter((row) => row.claim_enabled_at && row.paired_via !== "signup_secret");
  const pick = approved.find((row) => advertisesRelay(row.claim_protocols)) ?? approved[0];
  if (!pick) return null;
  return {
    label: (pick.label || "").trim() || "your computer",
    lastSeenAt: pick.last_seen_at,
    deliversNotes: advertisesRelay(pick.claim_protocols),
  };
}
