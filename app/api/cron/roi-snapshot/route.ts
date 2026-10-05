import { NextResponse, type NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { checkCronAuth } from "@/lib/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  if (!tursoConfigured()) {
    return NextResponse.json({ ok: false, error: "Database not configured" }, { status: 503 });
  }

  const db = getTursoClient();
  const today = new Date().toISOString().slice(0, 10);
  // We want to calculate stats for the previous 24h
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    // Get all tenants
    const rTenants = await db.execute({
      sql: `SELECT DISTINCT tenant_id FROM user_profiles WHERE tenant_id IS NOT NULL`,
      args: [],
    });

    const tenants = rTenants.rows.map((r) => String(r.tenant_id));

    let processed = 0;
    for (const tenant of tenants) {
      // Get AI actions taken
      const rEvents = await db.execute({
        sql: `SELECT COUNT(id) as cnt FROM agent_events WHERE tenant_id = ? AND created_at >= ?`,
        args: [tenant, yesterday],
      });
      const aiActions = Number(rEvents.rows[0]?.cnt || 0);

      // Estimate hours saved (assume each AI action saves 5 minutes, 5/60 = 0.083)
      const hoursSavedEst = aiActions * 0.083;
      
      // Get leads processed
      const rLeads = await db.execute({
        sql: `SELECT COUNT(id) as cnt FROM leads WHERE tenant_id = ? AND updated_at >= ?`,
        args: [tenant, yesterday],
      });
      const leadsProcessed = Number(rLeads.rows[0]?.cnt || 0);

      // Insert or replace snapshot
      await db.execute({
        sql: `INSERT INTO client_roi_snapshots 
              (tenant_id, snapshot_date, ai_actions_taken, hours_saved_est, leads_processed)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(tenant_id, snapshot_date) DO UPDATE SET
              ai_actions_taken = excluded.ai_actions_taken,
              hours_saved_est = excluded.hours_saved_est,
              leads_processed = excluded.leads_processed,
              created_at = datetime('now')`,
        args: [tenant, today, aiActions, hoursSavedEst, leadsProcessed],
      });
      processed++;
    }

    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
