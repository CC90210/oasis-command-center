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

  try {
    const db = getTursoClient();

    // Find open tickets where sla_target is passed
    const r = await db.execute({
      sql: `SELECT id, tenant_id, title, severity 
            FROM support_tickets 
            WHERE status NOT IN ('resolved', 'closed') 
              AND sla_target < datetime('now')`,
      args: [],
    });

    const breachedTickets = r.rows;

    for (const ticket of breachedTickets) {
      // Create an agent_events entry for each breached ticket. 
      // Background systems (n8n, Python wrappers) will pick this up 
      // and send Telegram alerts to founders.
      await db.execute({
        sql: `INSERT INTO agent_events (event_type, agent_name, payload, created_at)
              VALUES ('support_sla_breached', 'system', ?, datetime('now'))`,
        args: [
          JSON.stringify({
            ticket_id: ticket.id,
            tenant_id: ticket.tenant_id,
            title: ticket.title,
            severity: ticket.severity,
          }),
        ],
      });
    }

    return NextResponse.json({ ok: true, breached_count: breachedTickets.length });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
