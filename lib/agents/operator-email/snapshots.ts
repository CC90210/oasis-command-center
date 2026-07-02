/**
 * lib/agents/operator-email/snapshots.ts — write a per-operator email metrics
 * snapshot (agent_email_snapshots, migration 108) after a monitor tick. Feeds
 * the dashboard cards. Best-effort: never throws, skips on any error.
 *
 * Metrics are computed from the last 24h of this operator's email
 * lead_interactions (the deal-matched rows the agent ingested).
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";

export async function writeSnapshot(tenantId: string, userId: string): Promise<void> {
  try {
    const db = getServiceSupabase();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const r = await db
      .from("lead_interactions")
      .select("direction, lead_id, metadata")
      .eq("tenant_id", tenantId)
      .eq("channel", "email")
      .eq("actor_user_id", userId)
      .gte("created_at", since)
      .limit(2000);
    if (r.error || !Array.isArray(r.data)) return;

    const rows = r.data as { direction?: string; lead_id?: string | null; metadata?: Record<string, unknown> | null }[];
    let emailsIn = 0;
    let emailsOut = 0;
    let lenderDeclines = 0;
    const deals = new Set<string>();
    for (const row of rows) {
      if (row.direction === "inbound") emailsIn += 1;
      else if (row.direction === "outbound") emailsOut += 1;
      if (row.lead_id) deals.add(row.lead_id);
      if ((row.metadata as Record<string, unknown> | null)?.lender_category === "declined") lenderDeclines += 1;
    }

    await db.from("agent_email_snapshots").insert({
      tenant_id: tenantId,
      user_id: userId,
      emails_in: emailsIn,
      emails_out: emailsOut,
      deals_with_email: deals.size,
      lender_declines: lenderDeclines,
      // awaiting_reply is thread-level (Phase 2b); left at default 0 for now.
      detail: { window_hours: 24, computed_at: new Date().toISOString() },
    });
  } catch {
    // metrics are best-effort — a snapshot failure must not affect the tick
  }
}
