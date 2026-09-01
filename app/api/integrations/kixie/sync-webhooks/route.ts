/**
 * POST /api/integrations/kixie/sync-webhooks — owner-only. Registers every
 * Kixie webhook event with the dashboard's public webhook endpoint.
 *
 * Phase 4 of the TT + Kixie full embedding plan (2026-06-01). Replaces
 * the manual "paste each URL into Kixie's dashboard" step with a single
 * one-click sync from Settings → Integrations.
 *
 * The 8 events registered (lib/integrations/kixie.ts KIXIE_WEBHOOK_EVENTS —
 * Kixie's REAL enum, verified live 2026-07-21):
 *   endcall, startcall, answeredcall, SMS, disposition, voicemail,
 *   scheduledactivity, cisummary
 *
 * All point at the same destination — the dashboard's
 * /api/webhooks/kixie route does the dispatch on `eventname`.
 *
 * Returns a per-event result array so the UI can render a checklist of
 * which events registered successfully.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getKixieCredentials, registerAllWebhooks } from "@/lib/integrations/kixie";
import { resolveSessionContext } from "@/lib/api-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await resolveSessionContext();
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Owner-only gate. Webhook registration mutates Kixie-side config; the
  // workspace owner is the right authority for that, not every team
  // member.
  const db = getServiceSupabase();
  const tenantId = session.tenantId;
  if (!session.isAdmin) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Administrator access is required to register webhooks." },
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
  // inbound event to a tenant via `tenants.custom_fields.kixie_business_id`
  // (the tenants table's jsonb config column — there is no `metadata` column).
  // Nothing else writes it, so stamp it here from the saved credentials — key +
  // business ID + this one click = fully wired. Merge (don't clobber) the rest
  // of custom_fields; a failure here doesn't block registration but is surfaced.
  let businessIdLinked = false;
  try {
    const t = await db.from("tenants").select("custom_fields").eq("id", tenantId).maybeSingle();
    const cf = ((t.data as { custom_fields?: Record<string, unknown> } | null)?.custom_fields) || {};
    if (cf.kixie_business_id !== creds.businessId) {
      const { error } = await db
        .from("tenants")
        .update({ custom_fields: { ...cf, kixie_business_id: creds.businessId } })
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

  // Attach the static auth header Kixie sends back on every delivery — this
  // IS the receiver's auth (Kixie cannot HMAC-sign; see the receiver route).
  // Registering without it would create hooks the receiver 401s, so refuse.
  const secret = (process.env.KIXIE_WEBHOOK_SECRET || "").trim();
  if (!secret) {
    return NextResponse.json(
      {
        ok: false,
        error: "missing_webhook_secret",
        message:
          "KIXIE_WEBHOOK_SECRET env is not set — set it (Vercel project env) before registering webhooks.",
      },
      { status: 500 },
    );
  }
  const headersJson = JSON.stringify([{ name: "X-Kixie-Token", value: secret }]);

  const results = await registerAllWebhooks(creds, webhookUrl, { headersJson });
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
