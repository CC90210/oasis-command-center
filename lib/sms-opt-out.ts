import type { getServiceSupabase } from "@/lib/supabase-server";

/**
 * Was this inbound reply an opt-out?
 *
 * THIS WAS ANCHORED AND EXACT until 2026-08-05: /^(STOP|UNSUBSCRIBE|QUIT|
 * CANCEL|END)$/i. A bare unpunctuated keyword matched and nothing else did, so
 * "Stop." with a period, "STOP!", "please stop texting me" and "take me off
 * your list" all sailed through as ordinary replies.
 *
 * The effect was measurable: 600 outbound SMS over 30 days produced ZERO
 * recorded opt-outs and ZERO suppression rows, against an expected 1-5%.
 *
 * That is not a style problem. 47 CFR 64.1200(a)(10), in force since
 * 2025-04-11, requires honoring revocation by ANY REASONABLE MEANS — a
 * consumer may not be required to use a particular word. Statutory damages are
 * $500 per message, $1,500 willful, with a private right of action and no cap.
 *
 * Detection now lives in lib/sms/compliance.ts, which is pure and tested
 * against both the regulatory keywords and natural-language revocation, and is
 * checked for FALSE POSITIVES too ("I want to cancel my other loan" must not
 * suppress a live deal).
 */
import { detectOptOut } from "@/lib/sms/compliance";

export function isStopCommand(body: unknown): boolean {
  if (typeof body !== "string") return false;
  return detectOptOut(body).optOut;
}

/** The full verdict, for callers that want to route "likely" opt-outs to human
 *  review while still suppressing immediately. Suppression is not deferred
 *  pending review: honoring late is the violation. */
export function classifyOptOut(body: unknown) {
  return detectOptOut(typeof body === "string" ? body : "");
}

type Db = ReturnType<typeof getServiceSupabase>;

function phoneLast10(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length !== 10) throw new Error("invalid_suppression_phone");
  return digits;
}

export async function suppressPhoneNumber(db: Db, input: {
  tenantId: string;
  phone: string;
  reason: string;
  source: string;
}): Promise<void> {
  const result = await db.from("sunbiz_phone_suppressions").upsert({
    tenant_id: input.tenantId,
    phone_last10: phoneLast10(input.phone),
    reason: input.reason,
    source: input.source,
    updated_at: new Date().toISOString(),
  }, { onConflict: "tenant_id,phone_last10" });
  if (result.error) throw new Error(`suppression_write_failed:${result.error.message}`);
}

export async function releasePhoneSuppression(db: Db, input: {
  tenantId: string;
  phone: string;
  source: string;
  leadId?: string | null;
}): Promise<void> {
  const last10 = phoneLast10(input.phone);
  const removed = await db.from("sunbiz_phone_suppressions")
    .delete()
    .eq("tenant_id", input.tenantId)
    .eq("phone_last10", last10);
  if (removed.error) throw new Error(`suppression_release_failed:${removed.error.message}`);
  const interaction = await db.from("lead_interactions").insert({
    tenant_id: input.tenantId,
    lead_id: input.leadId || null,
    type: "sms_opt_in_restored",
    channel: "sms",
    direction: "inbound",
    agent_source: input.source,
    from_phone: input.phone,
    metadata: {
      opt_in_restored: true,
      phone_last10: last10,
    },
    created_at: new Date().toISOString(),
  });
  if (interaction.error) throw new Error(`suppression_release_audit_failed:${interaction.error.message}`);
}
