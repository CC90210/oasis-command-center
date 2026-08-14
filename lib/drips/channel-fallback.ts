/**
 * lib/drips/channel-fallback.ts — reach the merchant on whatever we actually
 * have for them.
 *
 * ADON'S RULE (2026-08-10): "The ones that have emails will answer an email.
 * The ones that don't, if we have their number, we have to write a text to
 * them. Simple as that."
 *
 * WHAT IT REPLACES. The engine treated a step's channel as fixed: an email step
 * for a lead with no email was skipped and the sequence walked on. Measured
 * 2026-08-10, 68 rows had already been skipped as `no_email_for_email_step` —
 * every one a phone-only merchant who should have been texted. The sequence
 * looked like it ran; the person heard nothing.
 *
 * WHY THIS MATTERS MORE THAN IT SOUNDS. The gap is not marginal:
 *
 *   public_form         562 leads, 555 emailable  (99%)
 *   MCA WEBFORMS        407 leads, 167 emailable  (41%)  240 phone-only
 *   cold_call_tracker   119 leads,   0 emailable         119 phone-only
 *   breeze_uw_sheet      84 leads,   0 emailable          61 phone-only
 *
 * 420 of 1,197 leads are phone-only. Under the old behaviour an email-led
 * sequence reached none of them.
 *
 * Pure and free of "server-only" so the rule that decides whether a real person
 * hears from us is directly testable.
 */

import type { DripChannel } from "@/lib/drips/types";

export type Contactability = {
  hasEmail: boolean;
  hasPhone: boolean;
};

export type ChannelDecision =
  | { send: true; channel: DripChannel; substituted: boolean; reason: string }
  | { send: false; reason: "unreachable"; detail: string };

/**
 * Read what we can actually reach this lead on.
 *
 * A phone must have at least 10 digits to count. A shorter value is a partial
 * record, and treating it as reachable would send the step down a path that
 * fails at the provider rather than being recorded honestly here.
 */
export function contactabilityOf(data: Record<string, unknown>): Contactability {
  const email = String(data.email ?? "").trim();
  const phoneDigits = String(data.phone ?? "").replace(/\D/g, "");
  return {
    hasEmail: email.includes("@") && email.length >= 5,
    hasPhone: phoneDigits.length >= 10,
  };
}

/**
 * Choose the channel for one step.
 *
 * Email is preferred wherever it exists: it carries more, costs less, and does
 * not sit under the texting consent regime. Text is the fallback for the people
 * we have no email for, which is Adon's rule stated exactly.
 *
 * `preferred` is the channel the step was authored as. It is a preference, not
 * a constraint — EXCEPT where the step cannot survive translation (see
 * `channelLocked`), because silently turning a bank-statement request with an
 * attachment into a text is not the same message.
 */
export function resolveChannel(
  preferred: DripChannel,
  contact: Contactability,
  opts: { channelLocked?: boolean } = {},
): ChannelDecision {
  const canDo = (c: DripChannel) => (c === "email" ? contact.hasEmail : contact.hasPhone);

  if (canDo(preferred)) {
    return { send: true, channel: preferred, substituted: false, reason: `${preferred} available` };
  }

  // A locked step must not be rewritten onto another channel. It reports
  // unreachable so the miss is visible, rather than sending a different message
  // than the one that was written and approved.
  if (opts.channelLocked) {
    return {
      send: false,
      reason: "unreachable",
      detail: `step is locked to ${preferred} and the lead has no ${preferred === "email" ? "email address" : "phone number"}`,
    };
  }

  const alternate: DripChannel = preferred === "email" ? "sms" : "email";
  if (canDo(alternate)) {
    return {
      send: true,
      channel: alternate,
      substituted: true,
      reason: `no ${preferred === "email" ? "email address" : "phone number"}, reaching them by ${alternate} instead`,
    };
  }

  // Neither. Measured 2026-08-10 this is 37 leads overall, plus 23 of the 84
  // live subs — records created with no way to contact anyone. That is a data
  // problem upstream, and it must surface rather than being absorbed as a
  // routine skip.
  return {
    send: false,
    reason: "unreachable",
    detail: "lead has neither an email address nor a phone number",
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export type ProviderGapDecision =
  | { action: "fallback"; channel: DripChannel; reason: string }
  | { action: "hold"; reason: string };

/**
 * What to do when the channel we CAN reach the lead on is unavailable at the
 * PROVIDER, not at the contact record.
 *
 * These are different failures and the engine was conflating them. resolveChannel
 * above answers "can we reach this person at all"; this answers "the way we chose
 * is blocked upstream — now what". Measured 2026-08-14, the second question was
 * always answered "wait", and that produced the outage:
 *
 *   220 rows  Follow-up sequence        sms_channel_unavailable: Bluerise has no
 *                                       SMS numbers yet          → held 6h, forever
 *    54 rows  Viewed application nudge  sms_carrier_halt: 19 consecutive carrier
 *                                       failures                 → held 2h, repeatedly
 *
 * Nothing was overdue, nothing was failed, every send-side check read green —
 * and total drip volume was ONE email in 24 hours. A hold loop is invisible to
 * a monitor that only knows about overdue rows and failures.
 *
 * Bluerise will never have SMS numbers; it is a cold EMAIL brand. Holding an
 * emailable lead for a channel that is never coming back is not patience, it is
 * silence with extra steps.
 *
 * So: if the blocked channel has a usable alternate for THIS lead, take it. That
 * is not a new policy — it is exactly Adon's 2026-08-10 rule ("the ones that
 * have emails will answer an email") applied one layer further down, where the
 * obstacle is the provider rather than a missing field.
 *
 * HOLD is still right when:
 *   - the step is channel_locked (a statement request with an attachment is not
 *     a text, and must not be silently rewritten), or
 *   - there is no alternate we can reach them on, in which case waiting for the
 *     provider really is the only option.
 */
export function onProviderGap(args: {
  blocked: DripChannel;
  contact: Contactability;
  channelLocked?: boolean;
  gap: string;
}): ProviderGapDecision {
  const alternate: DripChannel = args.blocked === "email" ? "sms" : "email";
  const canDo = alternate === "email" ? args.contact.hasEmail : args.contact.hasPhone;

  if (args.channelLocked) {
    return { action: "hold", reason: `${args.gap} (step is locked to ${args.blocked}, not substituting)` };
  }
  if (!canDo) {
    return { action: "hold", reason: `${args.gap} (no ${alternate} for this lead either)` };
  }
  return {
    action: "fallback",
    channel: alternate,
    reason: `${args.gap} — reaching them by ${alternate} instead of holding`,
  };
}
