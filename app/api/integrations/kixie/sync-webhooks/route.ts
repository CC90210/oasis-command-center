/**
 * POST /api/integrations/kixie/sync-webhooks — owner-only. Registers every
 * Kixie webhook event with the dashboard's public webhook endpoint.
 *
 * Phase 4 of the TT + Kixie full embedding plan (2026-06-01). Replaces
 * the manual "paste each URL into Kixie's dashboard" step with a single
 * one-click sync from Settings → Integrations.
 *
 * The 9 events registered (lib/integrations/kixie.ts KIXIE_WEBHOOK_EVENTS):
 *   startcall, answeredcall, endcall, dispositioncall, voicemail,
 *   dialattempt, scheduledactivity, sms, cisummary
 *
 * All point at the same destination — the dashboard's
 * /api/webhooks/kixie route does the dispatch on `eventname`.
 *
 * Returns a per-event result array so the UI can render a checklist of
 * which events registered successfully.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getKixieCredentials, registerAllWebhooks } from "@/lib/integrations/kixie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Owner-only gate. Webhook registration mutates Kixie-side config; the
  // workspace owner is the right authority for that, not every team
  // member.
  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id,is_owner")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  const tenantId = (profile.data as { tenant_id?: string | null } | null)?.tenant_id;
  const isOwner = (profile.data as { is_owner?: boolean } | null)?.is_owner === true;
  if (!tenantId) {
    return NextResponse.json({ ok: false, error: "no_tenant" }, { status: 400 });
  }
  if (!isOwner) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only the workspace owner can register webhooks." },
      { status: 403 },
    );
  }

  let creds;
  try {
    creds = await getKixieCredentials(tenantId);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_credentials",
        message:
          err instanceof Error
            ? err.message
            : "Kixie API key + business ID not on file. Add them in Settings → Integrations first.",
      },
      { status: 400 },
    );
  }

  // Activation glue: the Kixie receiver (app/api/webhooks/kixie) resolves the
  // inbound event to a tenant via `tenants.metadata.kixie_business_id`. Nothing
  // else writes it, so stamp it here from the saved credentials — key +
  // business ID + this one click = fully wired. Merge (don't clobber) the rest
  // of metadata; a failure here doesn't block registration but is surfaced.
  let businessIdLinked = false;
  try {
    const t = await db.from("tenants").select("metadata").eq("id", tenantId).maybeSingle();
    const meta = ((t.data as { metadata?: Record<string, unknown> } | null)?.metadata) || {};
    if (meta.kixie_business_id !== creds.businessId) {
      const { error } = await db
        .from("tenants")
        .update({ metadata: { ...meta, kixie_business_id: creds.businessId } })
        .eq("id", tenantId);
      businessIdLinked = !error;
    } else {
      businessIdLinked = true;
    }
  } catch {
    businessIdLinked = false;
  }

  // Webhook destination — uses the dashboard's public URL.
  const baseUrl =
    (process.env.PUBLIC_APP_URL || "https://agent-dashboard-cc90210.vercel.app").replace(/\/$/, "");
  const webhookUrl = `${baseUrl}/api/webhooks/kixie`;

  const results = await registerAllWebhooks(creds, webhookUrl);
  const successCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: successCount > 0,
    webhook_url: webhookUrl,
    business_id_linked: businessIdLinked,
    registered: successCount,
    total: results.length,
    results,
  });
}
