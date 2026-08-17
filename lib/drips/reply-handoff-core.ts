/**
 * lib/drips/reply-handoff-core.ts — the drip is FIRST CONTACT ONLY. The moment
 * a merchant answers, it gets out of the way and a human takes over.
 *
 * Adon, 2026-08-17: "this drip is just meant for the first point of contact.
 * Once we have them answering, it should delegate it to our agent... they can
 * then log in to their Legacy account and take over the rest of the text."
 *
 * WHY THIS IS LOAD-BEARING RATHER THAN POLISH. Nothing cancelled a drip on a
 * reply before this. A merchant who answered "yes, what are the terms" would
 * still receive the day-2 nudge, the day-4 "how much did you have in mind", the
 * day-7 call offer and the day-11 breakup — while a human was mid-conversation
 * with them on the same number. That reads as nobody being home, which is worse
 * than never having texted.
 *
 * THREE OUTCOMES, deliberately distinct:
 *
 *   opt_out   STOP and friends. Suppress, cancel, and do NOT page an agent —
 *             there is nothing for a human to take over, and paging on an
 *             opt-out trains people to dismiss the channel.
 *   handoff   A real human reply. Cancel the remaining steps and page the
 *             agent so they can pick it up in TextTorrent.
 *   ignore    Our own outbound echoed back, an autoresponder, or a message we
 *             have already acted on. Cancels nothing, pages nobody.
 *
 * The auto-reply screen is deliberately narrow. A false "ignore" is a merchant
 * who answered and got a drip in the face plus no human; a false "handoff" is
 * one unnecessary notification. Those costs are not symmetric, so anything
 * ambiguous is treated as a real reply.
 *
 * Pure and free of "server-only" so the rule that decides whether a human is
 * told about a live merchant is directly testable.
 */

export type HandoffAction = "opt_out" | "handoff" | "ignore";

export type HandoffDecision = {
  action: HandoffAction;
  reason: string;
  /**
   * Whether a human should be paged.
   *
   * Not derivable from `action`, because the two kinds of opt-out differ.
   * detectOptOut separates an EXPLICIT regulatory keyword ("STOP") from a
   * LIKELY natural-language one ("take me off your list"), and its own contract
   * says the second is honoured AND routed to human review — it is the
   * ambiguous case, and a wrongly-suppressed merchant is invisible unless
   * somebody looks. An explicit STOP needs no review, and paging on those is
   * how a lane gets muted.
   */
  notifyAgent: boolean;
};

/**
 * Machine-generated replies that carry no human intent.
 *
 * Kept SHORT and anchored, because every entry here is a merchant we might
 * ignore. "out of office" and carrier notices are the realistic ones on an SMS
 * channel; anything cleverer risks silencing a real person who happened to use
 * a matching word.
 */
const AUTO_REPLY = [
  /^\s*auto(?:matic)?[- ]?reply\b/i,
  /\bout of (?:the )?office\b/i,
  /\bthis (?:number|line) (?:does not|doesn'?t) (?:accept|receive)\b/i,
  /\bmessage (?:blocking|blocked) is active\b/i,
  /\bunable to receive (?:sms|text)\b/i,
  /\bthe (?:number|person) you (?:are|'re) trying to reach\b/i,
];

/** Free-to-end-user carrier notices, which are not the merchant speaking. */
function isCarrierNotice(body: string): boolean {
  return /^\s*(?:free msg|free message|msg&data|notice)\b/i.test(body);
}

export type ReplyInput = {
  /** The inbound message text. */
  body: string;
  /** True when this message came FROM the merchant, not from us. */
  inbound: boolean;
  /** Whether the opt-out detector matched. Passed in rather than re-implemented
   *  so there is exactly one STOP rule in the codebase — the permissive
   *  detectOptOut, after the anchored regex produced 0 opt-outs in 600 sends. */
  optedOut: boolean;
  /** True when the opt-out was inferred from natural language rather than a
   *  regulatory keyword. Honoured either way; this only decides whether a human
   *  is asked to double-check it. */
  optOutAmbiguous?: boolean;
  /** True when a handoff has already been recorded for this lead. Assume
   *  duplicate delivery: the provider can and does resend, and the sync is
   *  re-runnable by design, so the second pass must not page again. */
  alreadyHandedOff: boolean;
};

export function decideHandoff(input: ReplyInput): HandoffDecision {
  if (!input.inbound) {
    return { action: "ignore", reason: "outbound message, not a reply", notifyAgent: false };
  }

  // Opt-out is checked FIRST and beats everything, including the
  // already-handed-off short circuit: a merchant who replied warmly on Monday
  // and STOP on Friday must still be suppressed on Friday.
  if (input.optedOut) {
    return {
      action: "opt_out",
      reason: input.optOutAmbiguous ? "opt-out inferred from natural language" : "merchant opted out",
      notifyAgent: Boolean(input.optOutAmbiguous),
    };
  }

  if (input.alreadyHandedOff) {
    return { action: "ignore", reason: "already handed to an agent", notifyAgent: false };
  }

  const body = String(input.body ?? "");
  if (!body.trim()) {
    // An empty inbound is usually an MMS or a delivery artefact. There is
    // nothing to show an agent, and the drip continuing is the safer error.
    return { action: "ignore", reason: "empty inbound message", notifyAgent: false };
  }

  if (isCarrierNotice(body)) {
    return { action: "ignore", reason: "carrier notice, not the merchant", notifyAgent: false };
  }
  for (const re of AUTO_REPLY) {
    if (re.test(body)) return { action: "ignore", reason: "automated reply", notifyAgent: false };
  }

  return { action: "handoff", reason: "merchant replied", notifyAgent: true };
}

/**
 * The one-line summary an agent sees. Short on purpose: it lands on a phone,
 * and the job is to get them into TextTorrent, not to reproduce the thread.
 */
export function handoffSummary(args: {
  businessName?: string | null;
  contactName?: string | null;
  phone: string;
  body: string;
}): string {
  const who = [args.contactName, args.businessName].filter(Boolean).join(" at ") || "A Live Sub";
  const quoted = String(args.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
  return `${who} (${args.phone}) replied: "${quoted}"`;
}
