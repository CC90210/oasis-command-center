/**
 * lib/drips/optout-cooloff-core.ts — someone who told us to stop does not hear
 * from the other channel the next morning.
 *
 * Adon, 2026-08-17: "we need to ensure that someone that says stop is not
 * texted from that account for, let's do, like a week, maybe two-week cool-off
 * period before they can be texted again from an email drip and then we have to
 * be alerted about this as well."
 *
 * WHAT THIS IS AND IS NOT.
 *
 * It is NOT a timer on the SMS opt-out. A STOP suppresses texting permanently
 * and that is not negotiable: under the TCPA an opt-out does not expire, and
 * resuming texts after fourteen days is a statutory claim per message, not a
 * cadence choice. sunbiz_phone_suppressions already enforces that and nothing
 * here weakens it.
 *
 * It IS the cross-channel gap, which was real. An SMS opt-out writes to the
 * PHONE suppression list, and the email drip reads the EMAIL one. So a merchant
 * could reply STOP to a text at 4pm and receive a Bluerise follow-up at 9am the
 * next morning — technically two separate channels, and obviously the same
 * company ignoring them. That is the complaint that costs a domain.
 *
 * So: a phone opt-out starts a cool-off on EMAIL to the same lead. Long enough
 * that we are visibly not circumventing them, and finite because email opt-out
 * and SMS opt-out are genuinely different permissions — someone who does not
 * want texts has not necessarily unsubscribed from email, and treating them as
 * identical would silently delete a channel we are allowed to use.
 *
 * Pure and free of "server-only" so the rule that decides whether a merchant
 * who asked us to stop hears from us again is directly testable.
 */

export type CooloffVerdict =
  | { held: false }
  | { held: true; reason: string; until: Date };

/** Days of email silence after a phone opt-out. Two weeks by default — the
 *  longer end of what Adon offered, because the cost of waiting is one delayed
 *  email and the cost of being wrong is a complaint from someone who already
 *  told us to stop. */
export function cooloffDays(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.DRIPS_OPTOUT_COOLOFF_DAYS ?? "").trim();
  const n = raw ? Number(raw) : 14;
  // Non-numeric falls back rather than becoming NaN, which would compare false
  // in every direction and silently disable the cool-off entirely.
  if (!Number.isFinite(n) || n < 0) return 14;
  return Math.floor(n);
}

/**
 * Is this lead inside the post-opt-out email cool-off?
 *
 * `optedOutAt` is whenever they told us to stop on the phone. Absent means they
 * never did, which is the overwhelmingly common case and must be cheap.
 *
 * An UNPARSEABLE timestamp holds rather than sends. We know an opt-out was
 * recorded — that is why the field exists — and we cannot tell how long ago.
 * Sending on "the date looks odd" is the wrong way to resolve that.
 */
export function emailCooloff(
  optedOutAt: unknown,
  now: Date,
  days: number,
): CooloffVerdict {
  if (optedOutAt === null || optedOutAt === undefined || optedOutAt === "") return { held: false };
  if (days <= 0) return { held: false };

  const t = typeof optedOutAt === "number" ? optedOutAt : Date.parse(String(optedOutAt));
  if (!Number.isFinite(t)) {
    // Hold for the full period from NOW: we cannot date the opt-out, so the
    // only safe assumption is that it just happened.
    const until = new Date(now.getTime() + days * 86_400_000);
    return { held: true, reason: "optout_cooloff (opt-out recorded, timestamp unreadable)", until };
  }

  const until = new Date(t + days * 86_400_000);
  if (until.getTime() <= now.getTime()) return { held: false };

  const daysLeft = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 86_400_000));
  return {
    held: true,
    reason: `optout_cooloff (said stop by text; ${daysLeft}d of ${days} left)`,
    until,
  };
}
