/**
 * Shell chrome status — the sidebar's "agent live" and "bridge online" dots.
 *
 * P1 instant-load (2026-09-01): these two signals used to be resolved INSIDE
 * the root layout's await block, which meant every full page load paid their
 * Turso round trips (snapshot read + bridge read, the bridge one internally
 * sequential) before ANY content could stream. They are cosmetic chrome — an
 * operator can act on a page whose status dots arrive a beat later — so the
 * layout now renders them off (idle/offline) and the Sidebar client fetches
 * /api/shell/status after paint (see Sidebar's deferStatus prop).
 *
 * The primary-agent resolution here is EXTRACTED from the layout, not
 * duplicated: both the layout (which still needs the agent slug for the
 * sidebar label) and the status route call this one function, so the
 * "validate primary_agent against manifest-enabled agents" rule (a
 * cross-tenant heartbeat-leak guard) cannot drift between them.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { getBridgeOnline } from "@/lib/queries";
import { resolveEnabledAgentSlugs } from "@/lib/manifest/agent-roster";
import type { TenantManifest } from "@/lib/manifest/schema";
import { safe } from "@/lib/api-helpers";

export interface ProfileForAgent {
  primary_agent?: string | null;
  agents_enabled?: string[] | null;
}

/**
 * Which agent slug drives the heartbeat lookup + sidebar label. Validates
 * profile.primary_agent against the tenant's manifest-enabled agents before
 * use — a corrupted profile carrying another tenant's agent slug would
 * otherwise read a foreign heartbeat (cross-tenant signal leak).
 */
export function resolvePrimaryAgent(
  profile: ProfileForAgent | null,
  manifestForAgent: TenantManifest | null,
): string {
  const manifestEnabled = resolveEnabledAgentSlugs({
    manifestAgents: manifestForAgent ? manifestForAgent.agents || [] : null,
    legacyProfileAgents: profile?.agents_enabled,
  });
  const requested = (profile?.primary_agent || "").toLowerCase();
  const manifestPrimary = manifestForAgent?.agents
    ?.find((a) => a.primary && a.enabled)
    ?.slug?.toLowerCase();
  return manifestEnabled.includes(requested)
    ? requested
    : manifestPrimary || manifestEnabled[0] || requested || "bravo";
}

const LIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * The two dot values, resolved in parallel and individually isolated — one
 * failing read renders its dot "off", never a 500 (same safe() degradation
 * the layout used when these lived there).
 *
 * KNOWN LIMIT, INHERITED NOT INTRODUCED (Codex P2, 2026-09-01):
 * agent_state_snapshot has NO tenant_id column — it is per-agent_name
 * globally (documented at lib/queries.ts:700 and :721, where the column is
 * explicitly awaited). Two tenants enabling the same shared agent slug read
 * the same heartbeat row; the layout ran this exact query with this exact
 * semantic before P1 moved it here. Mitigations that DO hold today: the
 * slug is manifest-validated per tenant (resolvePrimaryAgent), the route is
 * session-gated, and ONLY two booleans ever leave the server — no snapshot
 * fields pass through (pinned in tests/perf-p1.test.ts). When the tenant
 * column lands, add `.eq("tenant_id", ...)` here and in lib/queries.ts's
 * readers in the same change.
 */
export async function getShellStatus(
  agent: string,
  tenantId: string | null,
): Promise<{ primaryAgentLive: boolean; bridgeOnline: boolean }> {
  const [snap, bridgeOnline] = await Promise.all([
    safe(
      "shell_status.agent_state_snapshot",
      (async () => {
        const db = getServiceSupabase();
        const r = await db
          .from("agent_state_snapshot")
          .select("last_tick_at")
          .eq("agent_name", agent)
          .maybeSingle();
        return { data: r.data as { last_tick_at?: string | null } | null };
      })(),
      { data: null as { last_tick_at?: string | null } | null },
    ),
    safe("shell_status.bridge_online", getBridgeOnline(tenantId), false),
  ]);
  const lastTick = snap.data?.last_tick_at;
  return {
    primaryAgentLive: !!lastTick && Date.now() - new Date(lastTick).getTime() < LIVE_WINDOW_MS,
    bridgeOnline,
  };
}
