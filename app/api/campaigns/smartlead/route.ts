/**
 * /api/campaigns/smartlead — cold-email console backend.
 *   GET  → mailbox warmup health + campaign list (admin).
 *   POST → { action:'launch' } runs a cold campaign through runColdCampaign (suppression +
 *          blast-safety + dry-run rails); { action:'register_webhook' } wires the Smartlead
 *          webhook to our suppression receiver. Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getSmartleadClient } from "@/lib/integrations/smartlead/client";
import { smartleadHealth, runColdCampaign, registerSmartleadWebhook, type ColdRecipient } from "@/lib/integrations/smartlead/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  const health = await smartleadHealth();
  const client = getSmartleadClient();
  let campaigns: unknown[] = [];
  if (client) {
    try {
      const raw = await client.listCampaigns();
      campaigns = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] } | null)?.data || [])) as unknown[];
    } catch { /* health already reflects connectivity */ }
  }
  return NextResponse.json({ ok: true, health, campaigns });
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  let body: {
    action?: string;
    campaign_name?: string;
    recipients?: ColdRecipient[];
    subject?: string;
    email_body?: string;
    daily_cap?: number;
    timezone?: string;
  } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }

  if (body.action === "register_webhook") {
    const client = getSmartleadClient();
    if (!client) return NextResponse.json({ ok: false, error: "not_configured" }, { status: 400 });
    const secret = (process.env.SMARTLEAD_WEBHOOK_SECRET || "").trim();
    if (!secret) return NextResponse.json({ ok: false, error: "webhook_secret_not_set" }, { status: 400 });
    const base = (process.env.PUBLIC_APP_URL || "https://oasisai.work").replace(/\/$/, "");
    const url = `${base}/api/integrations/smartlead/webhook?secret=${encodeURIComponent(secret)}`;
    const r = await registerSmartleadWebhook(client, url);
    return NextResponse.json(r, { status: r.ok ? 200 : 502 });
  }

  // Default: launch a cold campaign.
  const campaignName = (body.campaign_name || "").trim();
  const subject = (body.subject || "").trim();
  const emailBody = (body.email_body || "").trim();
  if (!campaignName) return NextResponse.json({ ok: false, error: "campaign_name_required" }, { status: 400 });
  if (!subject) return NextResponse.json({ ok: false, error: "subject_required" }, { status: 400 });
  if (!emailBody) return NextResponse.json({ ok: false, error: "email_body_required" }, { status: 400 });
  if (!body.recipients?.length) return NextResponse.json({ ok: false, error: "recipients_required" }, { status: 400 });

  const result = await runColdCampaign({
    tenantId: session.tenantId,
    userId: session.userId,
    campaignName,
    recipients: body.recipients,
    subject,
    body: emailBody,
    dailyCap: body.daily_cap,
    timezone: body.timezone,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : result.status || 400 });
}
