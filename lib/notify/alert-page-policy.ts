/**
 * alert-page-policy.ts — decide whether an agent alert should PAGE Telegram.
 *
 * Pure module (no I/O, no secrets, no `server-only` guard) so the decision that
 * governs whether an operator hears about a failure is unit-testable directly,
 * matching the sibling telegram-format.ts convention. lib/notify/agent-alert.ts
 * is its only importer; it supplies the DB facts, this decides.
 *
 * The rule, in one line: suppression means "you already know", never "it got
 * worse while you weren't looking."
 *
 * Background: `telegramOncePerOpen` was added 2026-07-23 to stop a notification
 * storm (one page per claimed drip row during a TT credit outage). Applied
 * naively it also swallows ESCALATIONS — an open card for a lead missing a
 * credit score would silently absorb a later retry that came back missing
 * business_name, which is urgent (codex review 2026-07-29). So suppression is
 * gated on the refreshed card carrying materially the SAME news.
 */

export type AlertSeverity = "info" | "warn" | "urgent";

/**
 * Is the incoming alert the same news as the open card it just refreshed?
 *
 * Same severity, and — when the caller fingerprints its content — the same
 * signature. A card written before signatures existed has none, so it reads as
 * CHANGED and the page goes through. Every unknown resolves toward loud.
 */
export function isSameNews(args: {
  existingSeverity: string | null | undefined;
  existingSignature: unknown;
  nextSeverity: AlertSeverity;
  nextSignature?: string;
}): boolean {
  if (args.existingSeverity !== args.nextSeverity) return false;
  if (args.nextSignature === undefined) return true;
  return args.existingSignature === args.nextSignature;
}

/**
 * Should this alert push to Telegram?
 *
 * - `telegram` overrides everything; otherwise info is silent, warn/urgent page.
 * - `telegramOncePerOpen` suppresses ONLY a verified refresh of an open card
 *   that carried the same news. A failed/unknown DB write leaves
 *   `refreshedExisting` false, so it pages (fail loud, per the fail-closed rule
 *   applied to monitoring: never go quiet on an error).
 */
export function shouldPageTelegram(args: {
  severity: AlertSeverity;
  telegram?: boolean;
  telegramOncePerOpen?: boolean;
  /** A refresh of an already-open card was VERIFIED (update returned no error). */
  refreshedExisting: boolean;
  /** That refreshed card carried the same news (see isSameNews). */
  refreshedUnchanged: boolean;
}): boolean {
  const wanted = args.telegram ?? args.severity !== "info";
  if (!wanted) return false;
  return !(args.telegramOncePerOpen && args.refreshedExisting && args.refreshedUnchanged);
}
