/**
 * lib/consent/marketing-send-gate.ts — the ONE gate a MARKETING send to a
 * lead must pass, for every workspace this ledger covers.
 *
 * WHO CALLS THIS, AND WHO DOES NOT.
 *   - SunBiz and Bluerise are UNCHANGED. Their marketing/drip machinery
 *     (lib/drips/executor.ts, lib/bulk-email/dispatch.ts) is hard-locked to
 *     those two brands (toDripBrand throws on anything else; dispatch.ts's
 *     own `sunbizTenants` check refuses every other tenant's row outright)
 *     and already gates on Opt-in Vault's TCPA-grade consent artifact
 *     (lib/sms/consent.ts smsGate, lib/consent/optinvault.ts). Nothing here
 *     touches that path.
 *   - Every OTHER workspace — including OASIS's own — has NO live, generic
 *     marketing/nurture/drip automation today. Confirmed by reading both
 *     candidate engines: lib/drips/executor.ts refuses a non-SunBiz/Bluerise
 *     brand outright, and lib/bulk-email/dispatch.ts's bulk templates are
 *     "the SunBiz library" by its own doc comment, gated to tenant slug
 *     "submissions". lib/oasis-default-sequences.ts defines OASIS's own
 *     starter sequences but nothing reads it — it is dead code (verified:
 *     no import of OASIS_DEFAULT_SEQUENCES anywhere in this repo on
 *     2026-10-11). Reported here rather than silently wired into a path
 *     that does not run, because a gate nothing calls is not a gate.
 *
 * THIS FUNCTION IS THE DESIGNATED CHOKEPOINT for whichever slice builds that
 * engine next (the spec's V4 "booking" / V5 "attribution" / the WhatsApp
 * customer-messaging move, or a future generic drip executor). Call this
 * before every send on every channel, to every lead outside SunBiz/Bluerise.
 *
 * TRANSACTIONAL SENDS NEVER CALL THIS. The direct reply to a lead's own
 * enquiry — lib/forms/oasis-funnel-email.ts deliverWelcomeEmail (the
 * ai-audit "here is your answer" email), lib/forms/resume-link.ts (continue
 * your own in-progress form), the dashboard's "reply to this lead"
 * composer (app/api/leads/[id]/email) — answers the enquiry itself and is
 * allowed regardless of a ticked box, per the design: "the enquiry is still
 * answered; marketing sends refuse." Routing one of those through this gate
 * would be the opposite bug: refusing to answer someone who just asked a
 * question, because they declined to be marketed to.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasTickedConsent } from "./ledger";
import type { ConsentChannel } from "./ledger-disclosure";

export type MarketingSendVerdict =
  | { allow: true }
  | { allow: false; reason: "no_ticked_consent" };

/**
 * May a MARKETING send reach this lead on this channel?
 *
 * Thin by design: hasTickedConsent already fails closed on a read error
 * (lib/consent/ledger.ts) and already treats "no row" the same as an
 * explicit decline. This wrapper exists so a call site reads as a decision
 * ("marketingSendAllowed") rather than a database fact ("hasTickedConsent"),
 * and so the day a real sender is built, its PR is "check this one
 * function", not "re-derive the consent rule".
 */
export async function marketingSendAllowed(
  db: SupabaseClient,
  args: { tenantId: string; leadId: string; channel: ConsentChannel },
): Promise<MarketingSendVerdict> {
  const ticked = await hasTickedConsent(db, args);
  return ticked ? { allow: true } : { allow: false, reason: "no_ticked_consent" };
}
