/**
 * lib/booking/sms-consent.ts - may a founder meeting's reminders be texted?
 *
 * The answer is the consent ledger's: the "text me" box the lead ticked (or
 * unticked) on a public form, for THIS phone number (lib/consent/ledger.ts).
 * Both booking paths used to hardcode false (CC, 2026-10-28: five of the eight
 * leads who missed calls that week had ticked it and were never texted).
 * Fails closed: no phone, no ledger answer, or a ledger that cannot be read is
 * "no", logged, never a guess.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consentState, hasTickedConsent } from "@/lib/consent/ledger";

export async function bookingSmsConsent(
  db: SupabaseClient,
  tenantId: string,
  phone: unknown,
  read: typeof hasTickedConsent = hasTickedConsent,
): Promise<boolean> {
  const destination = typeof phone === "string" ? phone.trim() : "";
  if (!destination) return false;
  try {
    return await read(db, { tenantId, channel: "sms", destination });
  } catch (error) {
    console.error("[booking.sms-consent] ledger read failed; texts stay off for this booking", {
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    });
    return false;
  }
}

/**
 * Right before a queued reminder is texted: has the lead since taken the
 * "text me" back (Codex review of #774)? The meeting's sms_consent is a
 * snapshot from booking; the ledger holds every later choice.
 *   - "withdrawn" / "declined" as the latest decision -> "no": never texted.
 *   - the ledger cannot be read -> "unknown": the text waits for the next run.
 *   - no ledger row at all -> "yes": consent captured on the lead page with
 *     its own proof (grantFounderMeetingSmsConsent) has no ledger row, and the
 *     snapshot stands.
 */
export async function smsConsentStillGiven(
  db: SupabaseClient,
  tenantId: string,
  phone: string,
  read: typeof consentState = consentState,
): Promise<"yes" | "no" | "unknown"> {
  const state = await read(db, { tenantId, channel: "sms", destination: phone });
  if (state === "withdrawn" || state === "declined") return "no";
  if (state === "unknown") return "unknown";
  return "yes";
}
