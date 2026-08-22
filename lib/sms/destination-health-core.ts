/**
 * lib/sms/destination-health-core.ts — can this PHONE receive a text at all?
 *
 * WHY THIS EXISTS (measured 2026-08-20). Carrier verdicts, split by where the
 * lead's phone number came from:
 *
 *   looked up (TruePeopleSearch)   8 delivered   3 failed
 *   typed in on the application    0 delivered  53 failed
 *
 * That is not a sending problem. A number a merchant writes on an application
 * is usually the OFFICE LINE, and a landline physically cannot receive SMS. We
 * were not being blocked; we were texting desk phones.
 *
 * It looked like an outage on 2026-08-19 because the cohort changed. Live Subs
 * (looked-up mobiles) delivered 8 of 8 on 08-18; the next day the viewed-
 * application sequence started working through application-provided numbers and
 * every send failed. Same lines, same copy: the exact refused message was later
 * replayed from the same line to a mobile and delivered.
 *
 * THE ASYMMETRY THIS ENCODES. One delivery proves a number can receive texts,
 * permanently — a landline never delivers once. One failure proves much less:
 * a handset can be off, out of coverage, or full. So delivery is conclusive and
 * failure needs corroboration.
 */

/** One carrier verdict for one destination. */
export type DestinationOutcome = {
  /** Last 10 digits. The only form that compares reliably — a formatted number
   *  silently never matches, which is how the phone suppression table was
   *  getting missed. */
  last10: string;
  status: "delivered" | "failed" | "unknown";
  at: string;
};

export type DestinationVerdict = {
  last10: string;
  /** May the drip engine text this number? */
  textable: boolean;
  reason: string;
  delivered: number;
  failed: number;
};

/**
 * How many failures, with no delivery ever, before we stop texting a number.
 *
 * Two, not one. A single failure can be a handset that is off, and benching a
 * real mobile costs a reachable merchant. Two consecutive failures on a number
 * that has NEVER delivered is a landline until proven otherwise, and the second
 * attempt costs one credit to buy that certainty.
 */
export const FAILURES_BEFORE_UNTEXTABLE = 2;

export function normalizeLast10(phone: unknown): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/**
 * WE ALREADY KNOW WHICH NUMBERS ARE LANDLINES. We were not looking.
 *
 * Every lead that has been through a phone lookup carries
 * `phone_lookup_candidates`, and each entry is tagged:
 *
 *   [{"type":"Wireless","number":"+1231..."},{"type":"Landline","number":"+1616..."}]
 *
 * So the line type never had to be inferred from failures at all. Reading it
 * costs nothing and, unlike failure-counting, it is right the FIRST time — no
 * message is spent discovering that a desk phone is a desk phone.
 */
export type LineType = "wireless" | "landline" | "unknown";

type Candidate = { type?: unknown; number?: unknown };

export function lineTypeFor(phone: unknown, candidates: unknown): LineType {
  const want = normalizeLast10(phone);
  if (!want || !Array.isArray(candidates)) return "unknown";
  for (const c of candidates as Candidate[]) {
    if (!c || typeof c !== "object") continue;
    if (normalizeLast10(c.number) !== want) continue;
    const t = String(c.type ?? "").trim().toLowerCase();
    if (t === "wireless" || t === "mobile" || t === "cell") return "wireless";
    if (t === "landline" || t === "fixed") return "landline";
    return "unknown";
  }
  return "unknown";
}

/** Every wireless number known for a lead, in candidate order. */
export function wirelessCandidates(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const out: string[] = [];
  for (const c of candidates as Candidate[]) {
    if (!c || typeof c !== "object") continue;
    const t = String(c.type ?? "").trim().toLowerCase();
    if (t !== "wireless" && t !== "mobile" && t !== "cell") continue;
    const last10 = normalizeLast10(c.number);
    if (last10 && !out.includes(last10)) out.push(last10);
  }
  return out;
}

/**
 * Decide whether one destination may be texted.
 *
 * Fails OPEN for an unknown number, deliberately: we cannot learn that a number
 * is a mobile without trying it once, and refusing every untried number would
 * stop the channel entirely. The cost of being wrong is one message; the cost
 * of failing closed here is the whole programme.
 */
/**
 * Is this number PROVEN to receive texts?
 *
 * Stricter than `textable`, and the two answer different questions:
 *
 *   textable  — "no reason to think this will fail" (fails OPEN on unknown, so
 *               a new number can be tried once and learned from)
 *   verified  — "we have positive evidence this reaches a handset"
 *
 * WHY THE STRICTER ONE IS NEEDED (measured 2026-08-20). The follow-up cohort we
 * most want to text is 347 leads, 100% of them application-provided numbers,
 * and that provenance has delivered 0 of 53. Under `textable` every one of them
 * is a candidate, because none has failed twice yet and none carries a line
 * type. Sending 40/day into that would fail almost every message, and since 3
 * consecutive carrier failures bench a line and 5 halt a wire, the programme
 * would stop itself inside an hour and deliver LESS than a careful one.
 *
 * Two ways to qualify, and the order matters:
 *   1. a real delivery — observation, and it outranks any classification
 *   2. a phone lookup tagged the number Wireless
 *
 * A landline label or a bench always disqualifies, whatever else is true.
 */
export function isVerifiedMobile(
  outcomes: DestinationOutcome[],
  lineType: LineType | undefined,
): { verified: boolean; reason: string } {
  const delivered = outcomes.filter((o) => o.status === "delivered").length;
  // Observation first. A number that has actually reached a handset is a mobile
  // regardless of what any lookup called it.
  if (delivered > 0) {
    return { verified: true, reason: `delivered ${delivered} time(s)` };
  }
  if (lineType === "landline") {
    return { verified: false, reason: "phone lookup says landline" };
  }
  if (lineType === "wireless") {
    return { verified: true, reason: "phone lookup says wireless" };
  }
  return { verified: false, reason: "never verified — no delivery and no line type on file" };
}

export function destinationVerdict(
  outcomes: DestinationOutcome[],
  opts: { failuresBeforeUntextable?: number; lineType?: LineType; last10?: string } = {},
): DestinationVerdict {
  const limit = opts.failuresBeforeUntextable ?? FAILURES_BEFORE_UNTEXTABLE;
  const last10 = outcomes[0]?.last10 ?? opts.last10 ?? "";

  // A KNOWN LANDLINE IS NEVER TEXTABLE, and this is checked before any
  // failure-counting so it costs zero messages to act on. Failure-counting
  // alone could not do this job: measured 2026-08-20, the 53 failed
  // destinations each had exactly ONE failure, so a two-strike rule would have
  // texted every desk phone a second time to learn what the lookup already
  // said.
  if (opts.lineType === "landline") {
    // One caveat, and it is the reason this is not an unconditional return:
    // if the number has actually DELIVERED, the lookup is simply wrong about
    // it. Observation beats classification.
    const everDelivered = outcomes.some((o) => o.status === "delivered");
    if (!everDelivered) {
      return {
        last10,
        textable: false,
        reason: "phone lookup classifies this number as a landline",
        delivered: 0,
        failed: outcomes.filter((o) => o.status === "failed").length,
      };
    }
  }
  let delivered = 0;
  let failed = 0;
  for (const o of outcomes) {
    if (o.status === "delivered") delivered++;
    else if (o.status === "failed") failed++;
    // 'unknown' is not evidence in either direction and is not counted.
  }

  // ONE DELIVERY SETTLES IT, FOREVER. A landline never delivers once, so any
  // delivery proves this is a mobile. Later failures are then about the handset
  // (off, full, out of coverage), not about the line type, and must not bench a
  // number we have proven reachable.
  if (delivered > 0) {
    return { last10, textable: true, reason: `delivered ${delivered} time(s) before`, delivered, failed };
  }
  if (failed >= limit) {
    return {
      last10,
      textable: false,
      reason: `${failed} carrier failures and never delivered — almost certainly a landline`,
      delivered,
      failed,
    };
  }
  if (failed > 0) {
    return { last10, textable: true, reason: `${failed} failure(s), below the ${limit} needed to bench`, delivered, failed };
  }
  return { last10, textable: true, reason: "no history", delivered, failed };
}

/**
 * Which of a lead's phone numbers should we text?
 *
 * A lead can carry both the number it wrote on the application and one we
 * looked up. The measurement says those are not equivalent: looked-up numbers
 * delivered, application-provided numbers did not. So when both exist and the
 * application one has been proven untextable, use the looked-up one rather than
 * dropping the lead.
 *
 * Returns null when there is nothing textable, which the caller must treat as
 * "reach this person another way", never as "send anyway".
 */
export function chooseTextableNumber(
  candidates: Array<{ phone: unknown; source: "provided" | "looked_up" }>,
  verdicts: Map<string, DestinationVerdict>,
): { last10: string; source: "provided" | "looked_up" } | null {
  const usable = candidates
    .map((c) => ({ last10: normalizeLast10(c.phone), source: c.source }))
    .filter((c) => c.last10 !== "")
    .filter((c) => verdicts.get(c.last10)?.textable !== false);

  if (usable.length === 0) return null;
  // Prefer a number we have actually DELIVERED to, then a looked-up mobile,
  // then whatever is left. Proven beats probable beats unknown.
  const proven = usable.find((c) => (verdicts.get(c.last10)?.delivered ?? 0) > 0);
  if (proven) return proven;
  const lookedUp = usable.find((c) => c.source === "looked_up");
  if (lookedUp) return lookedUp;
  return usable[0];
}
