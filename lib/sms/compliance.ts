/**
 * lib/sms/compliance.ts — the SMS rules that decide whether a real person
 * legally receives a message.
 *
 * Pure, no I/O, no "server-only", so the rules with $500-per-message statutory
 * damages attached are directly testable.
 *
 * Researched 2026-08-05 from FCC rules, state statutes and carrier policy.
 * Two gaps this closes in the existing engine:
 *
 *   1. lib/tcpa-window.ts enforces a FLAT federal 8am-9pm. That is illegal in
 *      six states and Rhode Island closes three hours earlier than the code
 *      believes.
 *   2. Opt-out handling assumed a fixed keyword list. 47 CFR 64.1200(a)(10),
 *      in force since 2025-04-11, requires honoring revocation by "any
 *      reasonable means" — a consumer may not be required to use a specific
 *      word. "take me off your list" is a legally binding opt-out.
 */

// ---------------------------------------------------------------------------
// Opt-out detection
// ---------------------------------------------------------------------------

/** The regulatory list, 47 CFR 64.1200(a)(10). Explicitly NON-exhaustive. */
const EXPLICIT = [
  "stopall",
  "stop all",
  "stop",
  "unsubscribe",
  "unsub",
  "optout",
  "opt out",
  "opt-out",
  "revoke",
  "cancel",
  "quit",
  "end",
];

/**
 * Natural-language revocation. These are the ones a keyword list misses and
 * that therefore become violations. Matched as phrases rather than words so
 * ordinary conversation does not trip them.
 */
const LIKELY = [
  /take me off/i,
  /remove me/i,
  /\bdo ?n[o']?t (text|message|contact|call) me\b/i,
  /\bstop (texting|messaging|contacting)\b/i,
  /no more (texts|messages|emails)/i,
  /leave me alone/i,
  /lose my number/i,
  /never contact me/i,
];

export type OptOutResult = {
  optOut: boolean;
  /** explicit = a regulatory keyword. likely = natural language; honor it AND
   *  route to human review, because these are the ambiguous ones. */
  confidence: "explicit" | "likely" | "none";
  matched: string | null;
};

export function detectOptOut(raw: string): OptOutResult {
  const text = String(raw ?? "").trim().toLowerCase();
  if (!text) return { optOut: false, confidence: "none", matched: null };

  // Strip surrounding punctuation/whitespace for the keyword pass so "STOP!"
  // and "  stop.  " both match, without letting a keyword buried in a sentence
  // fire on its own (handled by the word-boundary check below).
  const cleaned = text.replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim();

  // A bare keyword, or a keyword as a standalone word in a short reply. The
  // length guard prevents "I want to cancel my other loan" from opting out:
  // a genuine opt-out is short, a sentence about cancelling something else is
  // not. Long messages fall through to the phrase patterns below.
  for (const kw of EXPLICIT) {
    if (cleaned === kw) return { optOut: true, confidence: "explicit", matched: kw };
  }
  if (cleaned.split(" ").length <= 4) {
    for (const kw of EXPLICIT) {
      const re = new RegExp(`(^|\\s)${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i");
      if (re.test(cleaned)) return { optOut: true, confidence: "explicit", matched: kw };
    }
  }

  // Natural-language revocation, at any length.
  for (const re of LIKELY) {
    const m = re.exec(text);
    if (m) return { optOut: true, confidence: "likely", matched: m[0] };
  }

  // "please stop texting me" style: an explicit keyword joined to a directive.
  if (/\b(stop|cancel|unsubscribe|remove)\b/i.test(text) && /\b(text|texts|texting|message|messages|messaging|list|contact)\b/i.test(text)) {
    return { optOut: true, confidence: "likely", matched: "keyword+directive" };
  }

  return { optOut: false, confidence: "none", matched: null };
}

// ---------------------------------------------------------------------------
// Quiet hours by state
// ---------------------------------------------------------------------------

export type QuietHours = {
  /** First hour a message may be sent, recipient local time. Inclusive. */
  startHour: number;
  /** First hour a message may NOT be sent. Exclusive upper bound. */
  endHour: number;
  /** Some states bar Sunday and holiday solicitation outright. */
  noSunday: boolean;
};

const FEDERAL: QuietHours = { startHour: 8, endHour: 21, noSunday: false };

const BY_STATE: Record<string, QuietHours> = {
  // 8pm cutoff.
  FL: { startHour: 8, endHour: 20, noSunday: false },
  MD: { startHour: 8, endHour: 20, noSunday: false },
  OK: { startHour: 8, endHour: 20, noSunday: false },
  // 8pm cutoff AND no Sunday or holiday solicitation.
  AL: { startHour: 8, endHour: 20, noSunday: true },
  LA: { startHour: 8, endHour: 20, noSunday: true },
  MS: { startHour: 8, endHour: 20, noSunday: true },
  // Strictest in the country.
  RI: { startHour: 9, endHour: 18, noSunday: false },
  // 9am start; Sunday opens at noon (applied in isWithinSendWindow).
  TX: { startHour: 9, endHour: 21, noSunday: false },
};

const NAME_TO_ABBR: Record<string, string> = {
  florida: "FL", maryland: "MD", oklahoma: "OK", alabama: "AL",
  louisiana: "LA", mississippi: "MS", "rhode island": "RI", texas: "TX",
};

function normalizeState(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s.length === 2) return s.toUpperCase();
  return NAME_TO_ABBR[s] || null;
}

/** The window for a state. Unknown or absent resolves to the FEDERAL default,
 *  which is the permissive one — so callers must treat an unresolved state as
 *  a reason to be careful elsewhere, not as a licence. */
export function quietHoursForState(state: unknown): QuietHours {
  const abbr = normalizeState(state);
  return (abbr && BY_STATE[abbr]) || FEDERAL;
}

/** FL, MD and OK cap messages per rolling 24h on the same subject. Applied
 *  nationally because a single national rule is enforceable and the cost of
 *  the conservative choice is one message. */
export function maxMessagesPer24h(_state?: unknown): number {
  return 3;
}

export type SendWindowResult = { ok: true } | { ok: false; reason: string };

/**
 * May a message go out to this state at this local time?
 *
 * `localTime` must ALREADY be the recipient's local time. Resolving that is the
 * caller's job (billing-address state first, area code as fallback) and which
 * source was used must be recorded — the FCC petition on timezone determination
 * has been open since March 2025 with no ruling, so the method is evidence.
 */
export function isWithinSendWindow(state: unknown, localTime: Date): SendWindowResult {
  const w = quietHoursForState(state);
  const abbr = normalizeState(state);
  const day = localTime.getUTCDay(); // 0 = Sunday
  const hour = localTime.getUTCHours();

  if (w.noSunday && day === 0) {
    return { ok: false, reason: `quiet_hours: ${abbr} bars Sunday solicitation` };
  }

  // Texas: Sunday opens at noon rather than 9am.
  let start = w.startHour;
  let end = w.endHour;
  if (abbr === "TX" && day === 0) start = 12;
  // Rhode Island: Saturday closes an hour earlier than weekdays.
  if (abbr === "RI" && day === 6) end = 17;

  if (hour < start) return { ok: false, reason: `quiet_hours: before ${start}:00 local` };
  if (hour >= end) return { ok: false, reason: `quiet_hours: at or after ${end}:00 local` };
  return { ok: true };
}
