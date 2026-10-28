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
import { hasTickedConsent } from "@/lib/consent/ledger";

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
