/**
 * GET /api/integrations/smartlead/status — cold-email health for the dashboard.
 * Reports whether Smartlead is configured, the mailbox count, and a warmup-health
 * roll-up. Admin-only; fails closed (no key → configured:false, never throws).
 */
import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getSmartleadClient } from "@/lib/integrations/smartlead/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Mailbox = { id?: number | string; from_email?: string; email?: string; warmup_details?: { status?: string; warmup_reputation?: string | number } };

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  const client = getSmartleadClient();
  if (!client) return NextResponse.json({ ok: true, configured: false, mailboxes: 0, note: "Set SMARTLEAD_API_KEY to connect." });

  try {
    const raw = await client.listEmailAccounts();
    const accounts = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] } | null)?.data || [])) as Mailbox[];
    const warming = accounts.filter((a) => String(a.warmup_details?.status || "").toUpperCase().includes("ACTIVE")).length;
    return NextResponse.json({
      ok: true,
      configured: true,
      mailboxes: accounts.length,
      warming,
      accounts: accounts.slice(0, 50).map((a) => ({
        id: a.id ?? null,
        email: a.from_email || a.email || "",
        warmup: a.warmup_details?.status || "unknown",
        reputation: a.warmup_details?.warmup_reputation ?? null,
      })),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, configured: true, error: "smartlead_call_failed", message: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
