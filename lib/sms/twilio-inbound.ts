import { createHmac, timingSafeEqual } from "node:crypto";
import type { getServiceSupabase } from "@/lib/supabase-server";
import { classifyOptOut } from "@/lib/sms-opt-out";

type Db = ReturnType<typeof getServiceSupabase>;
type TenantResolution = { tenantId: string; ownerUserId: string | null };
const MAX_TWILIO_CREDENTIAL_CANDIDATES = 25;
export const TWILIO_SYNC_DB_OPERATION_BUDGET = 14;

export type TwilioCarrierJobState = {
  intent?: string | null;
  proposed_action?: string | null;
  executed_action?: string | null;
};

export function pendingTwilioCarrierAction(
  job: TwilioCarrierJobState,
): "stop" | "start" | "help" | null {
  if (
    job.intent === "opt_out" &&
    job.proposed_action === "cancel_meeting" &&
    job.executed_action !== "suppress_and_cancel_sms"
  ) return "stop";
  if (
    job.proposed_action === "release_suppression" &&
    job.executed_action !== "release_suppression"
  ) return "start";
  if (
    job.proposed_action === "reply_help" &&
    job.executed_action !== "reply_help"
  ) return "help";
  return null;
}

export function twilioCarrierReplyForDelivery(
  job: TwilioCarrierJobState,
  delivery: {
    duplicate: boolean;
    resumedAction: "stop" | "start" | "help" | null;
  },
): "stop" | "start" | "help" | null {
  if (delivery.duplicate && delivery.resumedAction === null) return null;
  if (job.intent === "opt_out" && job.proposed_action === "cancel_meeting") return "stop";
  if (job.proposed_action === "release_suppression") return "start";
  if (job.proposed_action === "reply_help") return "help";
  return null;
}

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
  onDbOperation?: () => void,
  messagingServiceSid = "",
): Promise<TenantResolution | null> {
  if (toNumber) {
    onDbOperation?.();
    const account = await db.from("channel_accounts")
      .select("tenant_id,owner_user_id")
      .eq("provider", "twilio")
      .eq("is_active", true)
      .eq("from_phone", toNumber)
      .order("tenant_id", { ascending: true })
      .limit(2)
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

    onDbOperation?.();
    const target = normalizedTwilioPhone(toNumber);
    const targetMessagingService = messagingServiceSid.trim().toUpperCase();
    const credentialFields = targetMessagingService
      ? ["from_number", "messaging_service_sid"]
      : ["from_number"];
    const credentials = await db.from("tenant_integration_credentials")
      .select("tenant_id,field_key,encrypted_value")
      .eq("service", "twilio")
      .in("field_key", credentialFields)
      .order("field_key", { ascending: true })
      .order("tenant_id", { ascending: true })
      .limit(MAX_TWILIO_CREDENTIAL_CANDIDATES * credentialFields.length + 1);
    if (!credentials.error) {
      const rows = (credentials.data || []) as Array<{
        tenant_id: string;
        field_key: "from_number" | "messaging_service_sid";
        encrypted_value: string;
      }>;
      const fromNumberCandidates = rows.filter((row) => row.field_key === "from_number").length;
      const messagingServiceCandidates = rows.filter(
        (row) => row.field_key === "messaging_service_sid",
      ).length;
      if (
        fromNumberCandidates > MAX_TWILIO_CREDENTIAL_CANDIDATES ||
        messagingServiceCandidates > MAX_TWILIO_CREDENTIAL_CANDIDATES
      ) {
        console.warn("[webhooks.twilio.sms-inbound] credential fallback capped; channel account mapping required");
        return null;
      }
      try {
        const { decryptField } = await import("@/lib/field-encryption");
        const matchedTenants = new Set<string>();
        for (const row of rows) {
          try {
            const decrypted = decryptField(row.encrypted_value);
            const matchesFromNumber =
              row.field_key === "from_number" &&
              Boolean(target) &&
              normalizedTwilioPhone(decrypted) === target;
            const matchesMessagingService =
              row.field_key === "messaging_service_sid" &&
              Boolean(targetMessagingService) &&
              decrypted.trim().toUpperCase() === targetMessagingService;
            if (matchesFromNumber || matchesMessagingService) {
              matchedTenants.add(row.tenant_id);
            }
          } catch {
            // A row encrypted under another key cannot own this request here.
          }
        }
        if (matchedTenants.size === 1) {
          return { tenantId: [...matchedTenants][0], ownerUserId: null };
        }
        if (matchedTenants.size > 1) {
          console.warn("[webhooks.twilio.sms-inbound] ambiguous credential ownership", {
            destination_last4: target.slice(-4),
          });
          return null;
        }
      } catch (error) {
        console.warn("[webhooks.twilio.sms-inbound] credential decrypt unavailable", error);
      }
    } else {
      console.warn("[webhooks.twilio.sms-inbound] credential lookup degraded", credentials.error.message);
    }
  }

  const fallback = (env.TWILIO_TENANT_ID || "").trim();
  const fallbackNumber = normalizedTwilioPhone(env.TWILIO_FROM_NUMBER || "");
  const fallbackMessagingService = (env.TWILIO_MESSAGING_SERVICE_SID || "").trim().toUpperCase();
  const target = normalizedTwilioPhone(toNumber);
  const targetMessagingService = messagingServiceSid.trim().toUpperCase();
  const fallbackMatches =
    (Boolean(target) && fallbackNumber === target) ||
    (Boolean(targetMessagingService) && fallbackMessagingService === targetMessagingService);
  return fallback && fallbackMatches
    ? { tenantId: fallback, ownerUserId: null }
    : null;
}

export function twilioCarrierKeyword(body: string): "help" | "start" | null {
  const cleaned = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
  if (cleaned === "HELP" || cleaned === "INFO") return "help";
  if (cleaned === "START" || cleaned === "UNSTOP") return "start";
  return null;
}

export function shouldHonorTwilioOptOut(body: string): boolean {
  const cleaned = body.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const exactGlobalCommand =
    /^(?:please\s+)?(?:stop\s*all|stop|unsubscribe|unsub|opt\s*-?\s*out|revoke|quit|end)(?:\s+please)?$/i.test(cleaned);
  const unmistakableGlobalRevocation =
    exactGlobalCommand ||
    /\b(?:take me off|remove me|leave me alone|lose my number|never contact me)\b/i.test(body) ||
    /\b(?:do\s*not|don't|never)\s+(?:text|message|contact|call)\s+me\b/i.test(body) ||
    /\bstop\s+(?:all\s+)?(?:texts?|texting|messages?|messaging|contacting)\b/i.test(body) ||
    /\bcancel\s+all\s+(?:texts?|messages?|messaging|contact)\b/i.test(body) ||
    /\bno more (?:texts?|messages?|contact)\b/i.test(body) ||
    /\b(?:and|also)\s+(?:stop\s*all|stop|unsubscribe|unsub|opt\s*-?\s*out|revoke|quit|end)\s*[.!?]*$/i.test(body);
  if (unmistakableGlobalRevocation) return true;

  const meetingOnlyCancellation =
    /\b(?:cancel|reschedule|move)\b[\s\S]{0,40}\b(?:meeting|appointment|audit|call)\b/i.test(body) ||
    /\b(?:meeting|appointment|audit|call)\b[\s\S]{0,40}\b(?:cancel|reschedule|move)\b/i.test(body);
  const schedulingFollowUp =
    /\b(?:text|message)\s+me\b[\s\S]{0,40}\b(?:alternatives?|new\s+times?|other\s+times?|available\s+times?|slots?|options?)\b/i.test(body);
  if (meetingOnlyCancellation && schedulingFollowUp) return false;
  const verdict = classifyOptOut(body);
  if (!verdict.optOut) return false;
  if (verdict.confidence === "likely") return true;
  if (
    /\b(stop|cancel|unsubscribe|remove)\b/i.test(body) &&
    /\b(text|texts|texting|message|messages|messaging|list|contact)\b/i.test(body)
  ) return true;
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
