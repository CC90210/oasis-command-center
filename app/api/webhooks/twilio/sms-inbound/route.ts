import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { isStopCommand, suppressPhoneViaCasl } from "@/lib/sms-opt-out";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { nudgeConversations } from "@/lib/realtime/conversations-nudge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function verifyTwilioSignature(
  url: string,
  params: URLSearchParams,
  headerSig: string | null,
  authToken: string,
): boolean {
  if (!headerSig) return false;
  const token = authToken.trim();
  if (!token) return false;

  const sortedParams = Array.from(params.entries()).sort(([aKey, aVal], [bKey, bVal]) => {
    const keyCompare = aKey.localeCompare(bKey);
    return keyCompare || aVal.localeCompare(bVal);
  });
  const signatureBase = sortedParams.reduce(
    (acc, [key, value]) => `${acc}${key}${value}`,
    url,
  );
  const expected = createHmac("sha1", token).update(signatureBase, "utf8").digest("base64");
  return timingSafeStringEqual(headerSig.trim(), expected);
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const params = new URLSearchParams(rawBody);
  const to = params.get("To") || "";
  const db = getServiceSupabase();
  const account = to
    ? await db
        .from("channel_accounts")
        .select("tenant_id, owner_user_id")
        .eq("provider", "twilio")
        .eq("is_active", true)
        .eq("from_phone", to)
        .maybeSingle()
    : { data: null };
  const tenantId =
    (account.data as { tenant_id?: string } | null)?.tenant_id ||
    process.env.TWILIO_TENANT_ID ||
    "";
  if (!tenantId) {
    console.error("[webhooks.twilio.sms-inbound] unmapped destination", { to_last4: to.replace(/\D/g, "").slice(-4) });
    return new NextResponse("Unmapped destination", { status: 422 });
  }
  const bundle = await getTenantIntegrationBundle(tenantId, "twilio");
  const authToken = bundle.auth_token || process.env.TWILIO_AUTH_TOKEN || "";

  if (!verifyTwilioSignature(req.url, params, req.headers.get("x-twilio-signature"), authToken)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const from = params.get("From") || "";
  const body = params.get("Body") || "";
  const messageSid = params.get("MessageSid") || params.get("SmsMessageSid") || "";

  if (from && isStopCommand(body)) {
    const result = await suppressPhoneViaCasl(from, "twilio_inbound");
    if (!result.ok) {
      console.error("[webhooks.twilio.sms-inbound] suppress-phone failed", result.error);
    }
  }

  const phoneLast10 = from.replace(/\D/g, "").slice(-10);
  const lead = phoneLast10
    ? await db
        .from("tenant_records")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("entity_type", "lead")
        .filter("data->>phone", "ilike", `%${phoneLast10}%`)
        .limit(1)
    : { data: [] };
  const leadId = ((lead.data || []) as Array<{ id: string }>)[0]?.id || null;
  const interaction = await db.from("lead_interactions").upsert({
    tenant_id: tenantId,
    lead_id: leadId,
    type: "sms_received",
    channel: "sms",
    direction: "inbound",
    agent_source: "twilio",
    provider: "twilio",
    provider_message_id: messageSid || null,
    from_phone: from,
    to_phone: to,
    content: body,
    content_preview: body.slice(0, 1024),
    actor_user_id: (account.data as { owner_user_id?: string | null } | null)?.owner_user_id || null,
    metadata: {
      provider: "twilio",
      message_sid: messageSid || null,
      account_sid: params.get("AccountSid") || null,
      opt_out_detected: from && isStopCommand(body),
    },
  }, {
    onConflict: "provider,provider_message_id",
    ignoreDuplicates: true,
  });
  if (interaction.error) {
    console.error("[webhooks.twilio.sms-inbound] persistence failed", interaction.error.message);
    return new NextResponse("Persistence failed", { status: 500 });
  }
  await nudgeConversations(tenantId);

  return new NextResponse("<Response/>", {
    status: 200,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}
