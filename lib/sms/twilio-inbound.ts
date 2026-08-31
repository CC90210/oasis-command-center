import { createHmac, timingSafeEqual } from "node:crypto";
import type { getServiceSupabase } from "@/lib/supabase-server";
import { classifyOptOut } from "@/lib/sms-opt-out";

type Db = ReturnType<typeof getServiceSupabase>;
type TenantResolution = { tenantId: string; ownerUserId: string | null };

function timingSafeStringEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function verifyTwilioSignature(
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

export function normalizedTwilioPhone(value: string): string {
  return value.replace(/\D/g, "");
}

export async function resolveTwilioInboundTenant(
  db: Db,
  toNumber: string,
  env: Record<string, string | undefined> = process.env,
): Promise<TenantResolution | null> {
  if (toNumber) {
    const account = await db.from("channel_accounts")
      .select("tenant_id,owner_user_id")
      .eq("provider", "twilio")
      .eq("is_active", true)
      .eq("from_phone", toNumber)
      .maybeSingle();
    if (!account.error && account.data) {
      const row = account.data as { tenant_id?: unknown; owner_user_id?: unknown };
      if (typeof row.tenant_id === "string" && row.tenant_id) {
        return {
          tenantId: row.tenant_id,
          ownerUserId: typeof row.owner_user_id === "string" ? row.owner_user_id : null,
        };
      }
    } else if (account.error) {
      console.warn("[webhooks.twilio.sms-inbound] channel account lookup degraded", account.error.message);
    }

    const credentials = await db.from("tenant_integration_credentials")
      .select("tenant_id,encrypted_value")
      .eq("service", "twilio")
      .eq("field_key", "from_number");
    if (!credentials.error) {
      const target = normalizedTwilioPhone(toNumber);
      try {
        const { decryptField } = await import("@/lib/field-encryption");
        for (const row of (credentials.data || []) as Array<{ tenant_id: string; encrypted_value: string }>) {
          try {
            if (normalizedTwilioPhone(decryptField(row.encrypted_value)) === target) {
              return { tenantId: row.tenant_id, ownerUserId: null };
            }
          } catch {
            // A row encrypted under another key cannot own this request here.
          }
        }
      } catch (error) {
        console.warn("[webhooks.twilio.sms-inbound] credential decrypt unavailable", error);
      }
    } else {
      console.warn("[webhooks.twilio.sms-inbound] credential lookup degraded", credentials.error.message);
    }
  }

  const fallback = (env.TWILIO_TENANT_ID || "").trim();
  return fallback ? { tenantId: fallback, ownerUserId: null } : null;
}

export function twilioCarrierKeyword(body: string): "help" | "start" | null {
  const cleaned = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned === "HELP" || cleaned === "INFO") return "help";
  if (cleaned === "START" || cleaned === "UNSTOP") return "start";
  return null;
}

export function shouldHonorTwilioOptOut(body: string): boolean {
  const verdict = classifyOptOut(body);
  if (!verdict.optOut) return false;
  if (verdict.confidence === "likely") return true;
  if (
    /\b(stop|cancel|unsubscribe|remove)\b/i.test(body) &&
    /\b(text|texts|texting|message|messages|messaging|list|contact)\b/i.test(body)
  ) return true;
  const cleaned = body.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const command = "(?:stopall|stop all|stop|unsubscribe|unsub|optout|opt out|opt-out|revoke|cancel|quit|end)";
  return new RegExp(`^(?:please\\s+)?${command}(?:\\s+please)?$`, "i").test(cleaned);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function twilioMessageResponse(message?: string): string {
  return message ? `<Response><Message>${xmlEscape(message)}</Message></Response>` : "<Response/>";
}
