import "server-only";

import { getServiceSupabase } from "@/lib/supabase-server";
import { getOasisSalesRepRoster, type MemberRow } from "@/lib/team";
import { OASIS_COLD_OUTBOUND_MOTION } from "@/lib/leads/canonical-lead-fields";
import {
  summarizeSalesRepLeads,
  type SalesLeadKpis,
  type SalesLeadMetricRow,
} from "@/lib/audit/sales-performance-core";

const PAGE_SIZE = 500;
const TOUCH_WINDOW_DAYS = 7;

export type SalesRepPerformance = {
  member: MemberRow;
  kpis: SalesLeadKpis | null;
  touches7d: number | null;
  error: string | null;
};

export type SalesTeamPerformance = {
  members: MemberRow[];
  rows: SalesRepPerformance[];
  error: string | null;
};

type AssignedSalesLeadMetricRow = SalesLeadMetricRow & {
  data?: (Record<string, unknown> & { assigned_to?: unknown }) | null;
};

async function loadTeamLeads(
  tenantId: string,
  repUserIds: readonly string[],
): Promise<Map<string, SalesLeadMetricRow[]>> {
  const db = getServiceSupabase();
  const byRep = new Map(repUserIds.map((id) => [id, [] as SalesLeadMetricRow[]]));
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await db
      .from("tenant_records")
      .select("id,data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .eq("data->>sales_motion", OASIS_COLD_OUTBOUND_MOTION)
      .in("data->>assigned_to", [...repUserIds])
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = (result.data || []) as AssignedSalesLeadMetricRow[];
    for (const row of page) {
      const repUserId = String(row.data?.assigned_to || "").trim().toLowerCase();
      byRep.get(repUserId)?.push(row);
    }
    if (page.length < PAGE_SIZE) return byRep;
  }
}

async function loadTeamTouches(
  tenantId: string,
  repUserIds: readonly string[],
): Promise<Map<string, number>> {
  const db = getServiceSupabase();
  const since = new Date(Date.now() - TOUCH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const byRep = new Map(repUserIds.map((id) => [id, 0]));
  for (let from = 0; ; from += PAGE_SIZE) {
    const result = await db
      .from("lead_interactions")
      .select("id,actor_user_id")
      .eq("tenant_id", tenantId)
      .in("actor_user_id", [...repUserIds])
      .gte("created_at", since)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    const page = (result.data || []) as Array<{ actor_user_id?: string | null }>;
    for (const row of page) {
      const repUserId = String(row.actor_user_id || "").trim().toLowerCase();
      if (byRep.has(repUserId)) byRep.set(repUserId, (byRep.get(repUserId) || 0) + 1);
    }
    if (page.length < PAGE_SIZE) return byRep;
  }
}

/**
 * Query-scoped OASIS sales scorecard. Every lead/touch read carries tenant_id
 * and a single authoritative rep auth_user_id before any row reaches memory.
 */
export async function getOasisSalesTeamPerformance(
  tenantId: string,
): Promise<SalesTeamPerformance> {
  let members: MemberRow[];
  try {
    members = await getOasisSalesRepRoster(tenantId);
  } catch (error) {
    console.error("[sales-performance.roster]", error);
    return { members: [], rows: [], error: "Sales roster is temporarily unavailable." };
  }

  const repUserIds = members.map((member) => member.auth_user_id!.trim().toLowerCase());
  if (repUserIds.length === 0) return { members, rows: [], error: null };

  let leadsByRep: Map<string, SalesLeadMetricRow[]>;
  let touchesByRep: Map<string, number>;
  try {
    [leadsByRep, touchesByRep] = await Promise.all([
      loadTeamLeads(tenantId, repUserIds),
      loadTeamTouches(tenantId, repUserIds),
    ]);
  } catch (error) {
    console.error("[sales-performance.metrics]", error);
    return {
      members,
      rows: members.map((member) => ({
        member,
        kpis: null,
        touches7d: null,
        error: "Metrics unavailable",
      })),
      error: null,
    };
  }

  const rows = members.map((member): SalesRepPerformance => {
    const repUserId = member.auth_user_id!.trim().toLowerCase();
    return {
      member,
      kpis: summarizeSalesRepLeads(leadsByRep.get(repUserId) || []),
      touches7d: touchesByRep.get(repUserId) ?? 0,
      error: null,
    };
  });

  return { members, rows, error: null };
}
