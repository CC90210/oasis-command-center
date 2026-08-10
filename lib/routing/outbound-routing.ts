/**
 * lib/routing/outbound-routing.ts — the one place that answers "who sends this,
 * and from where".
 *
 * WHY THIS EXISTS. The allocation was previously spread across the code as
 * implicit behaviour: brand-routing.ts decided a brand but only email ever read
 * it, SMS always went out from whichever rep owned the lead, and the
 * lender-shopout lock lived in its own test. Nothing could answer the whole
 * question at once, so nobody could see the gap this file was written to close:
 *
 *   a Bluerise-branded merchant would be EMAILED as Bluerise and TEXTED as
 *   SunBiz, from a SunBiz rep's number, in the same conversation.
 *
 * Two company names for one thread is the confusing first impression the brand
 * split exists to avoid, and it is the behaviour that earns spam complaints.
 *
 * THE ALLOCATION (Adon, 2026-08-09):
 *
 *   SunBiz email     submissions@sunbizfunding.com
 *                    - every merchant who already knows SunBiz
 *                    - EVERY lender shop-out, always, whatever brand owns the
 *                      lead: lenders only ever see SunBiz paper
 *   Bluerise email   submissions@bluerisebusinesscapital.com
 *                    - cold/sourced merchants who know nobody
 *                    - the follow-up act for SunBiz leads that went quiet
 *   TextTorrent      all SunBiz SMS: drips, rep 1:1, blasts
 *   Twilio           reserved for Bluerise SMS, NOT yet provisioned
 *
 *   Bluerise SMS is HELD until Bluerise has its own numbers. Adon's call: the
 *   merchant should hear one company name on both channels. Holding is not a
 *   failure and must never be recorded as one — a held step reschedules.
 *
 * WHY BLUERISE SMS CANNOT SIMPLY BORROW SUNBIZ'S NUMBERS. Beyond the two-names
 * problem, US carriers have hard-blocked unregistered 10DLC traffic since
 * 2023-09-01 (Twilio error 30034), and registration is per BRAND. Sending
 * Bluerise copy from SunBiz's registered numbers is exactly the campaign/content
 * mismatch that gets a brand filtered. Note the cost of getting this wrong is
 * the failure this codebase just spent a week on: carriers bill for blocked
 * messages, so the spend is real and the delivery is not.
 *
 * Pure and free of "server-only" so the rules that decide what a real merchant
 * receives are directly testable. Provider availability is injected, never read
 * from the environment here.
 */

import type { BrandKey } from "@/lib/email/brands";

/** Every outbound carrier/mailbox we can address. */
export type ProviderId = "gws" | "gws_bluerise" | "texttorrent" | "twilio";

export type OutboundChannel = "email" | "sms";

/**
 * What the message is FOR. Purpose outranks brand in exactly one case
 * (lender_shopout) and that exception is the whole reason this is an input.
 */
export type OutboundPurpose =
  /** An automated sequence step. */
  | "drip"
  /** Application links, signature confirmations, document requests. */
  | "transactional"
  /** A rep typing to one merchant. */
  | "rep_manual"
  /** Submission paperwork to a funder. Never merchant-facing. */
  | "lender_shopout";

export type RoutingInput = {
  channel: OutboundChannel;
  purpose: OutboundPurpose;
  /** The brand that owns this LEAD, from brand-routing/brand-store. */
  brand: BrandKey;
  /** Which providers can actually send right now. Injected so this stays pure
   *  and so a missing credential is a routing input, not a crash at send time. */
  available: ProviderAvailability;
};

/** Whether a provider is usable. `configured` = credentials exist.
 *  `enabled` = we have decided to use it. Both must hold. */
export type ProviderAvailability = Record<ProviderId, { configured: boolean; enabled: boolean }>;

export type RoutingDecision =
  | { send: true; provider: ProviderId; brand: BrandKey; channel: OutboundChannel; reason: string }
  | { send: false; hold: true; reason: string; blockedBy: ProviderId | "policy" };

/** The lane table. Purpose-specific overrides are applied before this. */
const EMAIL_BY_BRAND: Record<BrandKey, ProviderId> = {
  sunbiz: "gws",
  bluerise: "gws_bluerise",
};

/**
 * SMS by brand. Bluerise deliberately maps to twilio, which is not provisioned:
 * naming the intended provider makes the hold self-explanatory and means turning
 * Bluerise SMS on is a provisioning task, not a code change.
 */
const SMS_BY_BRAND: Record<BrandKey, ProviderId> = {
  sunbiz: "texttorrent",
  bluerise: "twilio",
};

function usable(a: ProviderAvailability, p: ProviderId): boolean {
  const s = a[p];
  return Boolean(s && s.configured && s.enabled);
}

/**
 * Resolve the single sending identity for one outbound message.
 *
 * Returns a HOLD rather than a failure when the intended provider is not ready.
 * The distinction is load-bearing: a hold means "this merchant is fine, we are
 * not", so the caller reschedules and nobody is dropped from a sequence or
 * marked undeliverable because we have not finished provisioning.
 */
export function routeOutbound(input: RoutingInput): RoutingDecision {
  const { channel, purpose, brand, available } = input;

  // Lender shop-out outranks everything, including the lead's brand. Funders
  // receive SunBiz paper only, so a Bluerise-owned merchant's submission still
  // goes out as SunBiz. This is a hard business rule, not a default.
  if (purpose === "lender_shopout") {
    if (channel !== "email") {
      return { send: false, hold: true, reason: "lender shop-out is email only", blockedBy: "policy" };
    }
    return usable(available, "gws")
      ? { send: true, provider: "gws", brand: "sunbiz", channel: "email", reason: "lender shop-out is always SunBiz" }
      : { send: false, hold: true, reason: "SunBiz mailbox unavailable and shop-out may not use another brand", blockedBy: "gws" };
  }

  if (channel === "email") {
    const provider = EMAIL_BY_BRAND[brand];
    return usable(available, provider)
      ? { send: true, provider, brand, channel, reason: `${brand} email` }
      : { send: false, hold: true, reason: `${provider} is not available`, blockedBy: provider };
  }

  // SMS.
  const provider = SMS_BY_BRAND[brand];
  if (!usable(available, provider)) {
    // Deliberately NOT falling back to the other brand's provider. Texting a
    // Bluerise merchant from a SunBiz number puts two company names on one
    // thread and sends Bluerise content through a campaign registered to
    // SunBiz, which is how a brand gets filtered.
    return {
      send: false,
      hold: true,
      reason:
        brand === "bluerise"
          ? "Bluerise has no SMS numbers yet - holding rather than texting as SunBiz"
          : `${provider} is not available`,
      blockedBy: provider,
    };
  }
  return { send: true, provider, brand, channel, reason: `${brand} SMS via ${provider}` };
}

/**
 * Which channels can reach this brand at all right now.
 *
 * Used by planners and the UI so a sequence is not built around a channel that
 * will only ever hold. Answers a different question from routeOutbound: "is
 * this worth scheduling", not "send this one now".
 */
export function reachableChannels(brand: BrandKey, available: ProviderAvailability): OutboundChannel[] {
  const out: OutboundChannel[] = [];
  for (const channel of ["email", "sms"] as const) {
    const d = routeOutbound({ channel, purpose: "drip", brand, available });
    if (d.send) out.push(channel);
  }
  return out;
}

/** Human-readable allocation, for the ops surface and for the handoff doc. */
export function describeAllocation(available: ProviderAvailability): string[] {
  const status = (p: ProviderId) =>
    !available[p]?.configured ? "not provisioned" : !available[p]?.enabled ? "configured, switched off" : "live";
  return [
    `SunBiz email   (gws)          -> SunBiz-known merchants + EVERY lender shop-out  [${status("gws")}]`,
    `Bluerise email (gws_bluerise) -> cold merchants + SunBiz follow-up act           [${status("gws_bluerise")}]`,
    `TextTorrent                   -> all SunBiz SMS: drips, rep 1:1, blasts          [${status("texttorrent")}]`,
    `Twilio                        -> reserved for Bluerise SMS                       [${status("twilio")}]`,
  ];
}
