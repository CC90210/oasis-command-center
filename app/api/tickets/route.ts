/**
 * /api/tickets — CRUD for support tickets.
 *
 * POST: Create a new ticket. Critical tickets trigger a Telegram notification.
 * GET: List tickets for the current tenant (founders see all).
 */
import { NextRequest, NextResponse } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { getActiveProfile } from "@/lib/queries";
import { resolveViewerSurface } from "@/lib/role-surfaces-session";

const SLA_TARGETS: Record<string, number> = {
  critical: 60,     // 1 hour
  high: 240,         // 4 hours
  medium: 1440,      // 24 hours
  low: 4320,         // 72 hours
};

export async function GET() {
  if (!tursoConfigured()) {
    return NextResponse.json({ tickets: [] });
  }

  const profile = await getActiveProfile();
  const surface = await resolveViewerSurface();
  const isFounder = surface.ok && surface.capabilities.canSeeSystemSurfaces;
  const tenantId = isFounder ? undefined : profile?.tenant_id || "";

  try {
    const db = getTursoClient();
    const tenantFilter = tenantId ? "WHERE tenant_id = ?" : "";
    const args = tenantId ? [tenantId] : [];
    const r = await db.execute({
      sql: `SELECT * FROM support_tickets ${tenantFilter} ORDER BY created_at DESC LIMIT 100`,
      args,
    });
    return NextResponse.json({ tickets: r.rows });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to load tickets", detail: String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  if (!tursoConfigured()) {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const profile = await getActiveProfile();
  if (!profile?.tenant_id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { title, description, severity = "medium" } = body;

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const slaMinutes = SLA_TARGETS[severity] || SLA_TARGETS.medium;
  const slaTarget = new Date(
    Date.now() + slaMinutes * 60 * 1000,
  ).toISOString();

  try {
    const db = getTursoClient();
    const r = await db.execute({
      sql: `INSERT INTO support_tickets
            (tenant_id, reporter_id, title, description, severity, sla_target)
            VALUES (?, ?, ?, ?, ?, ?)
            RETURNING *`,
      args: [
        profile.tenant_id,
        profile.id || null,
        title.trim(),
        description || null,
        severity,
        slaTarget,
      ],
    });

    const ticket = r.rows[0];

    // Log to agent_events for Operations page visibility
    try {
      await db.execute({
        sql: `INSERT INTO agent_events (event_type, agent_name, payload, created_at)
              VALUES ('support_ticket_created', 'system',
                      ?, datetime('now'))`,
        args: [
          JSON.stringify({
            ticket_id: ticket?.id,
            tenant_id: profile.tenant_id,
            title: title.trim(),
            severity,
          }),
        ],
      });
    } catch {
      // Non-fatal — the ticket was already created
    }

    return NextResponse.json({ ticket }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to create ticket", detail: String(err) },
      { status: 500 },
    );
  }
}
