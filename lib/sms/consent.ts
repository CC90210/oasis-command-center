/**
 * lib/sms/consent.ts — the consent artifact, and the gate that requires one.
 *
 * Pure, no I/O, no "server-only", so the rule that decides whether a text is
 * legal is directly testable.
 *
 * WHY AN ARTIFACT AND NOT A BOOLEAN. Email and SMS have inverted legal
 * postures. CAN-SPAM is opt-out: no consent needed, purchased lists are legal.
 * TCPA is opt-IN: marketing SMS to a mobile requires PRIOR EXPRESS WRITTEN
 * consent, damages are $500 per message and $1,500 willful, there is no cap,
 * there is a private right of action, and it is class-actionable.
 *
 * Critically, in TCPA litigation the DEFENDANT bears the burden of proving
 * consent. A `sms_ok: true` flag proves nothing. What proves consent is the
 * record of what the person was actually shown and when:
 *
 *   - the exact disclosure text displayed, stored verbatim and versioned
 *   - who was named as the sender in that text
 *   - timestamp, IP, and the URL the submission came from
 *   - the method (web form, verbal, imported)
 *
 * Carriers also audit this. TCR and vendors request proof during 10DLC review.
 *
 * FAILS CLOSED. No artifact means no SMS. That is not a style choice: an
 * undocumented send is indistinguishable, in front of a court, from a send with
 * no consent at all.
 */

export type ConsentMethod = "web_form" | "verbal" | "imported" | "api" | "unknown";

export type ConsentArtifact = {
  /** The exact text the person was shown, verbatim. Not a reference to it. */
  disclosureText: string;
  /** Who the disclosure named as the sender. Consent runs to a NAMED seller
   *  and is not freely transferable between brands or entities. */
  sellerNamed: string;
  capturedAtIso: string;
  /** Source URL of the form, or a description of the capture point. */
  sourceUrl: string | null;
  ipAddress: string | null;
  method: ConsentMethod;
  /** Version of the disclosure copy, so a later change is reconstructable. */
  disclosureVersion: string | null;
};

export type ConsentVerdict =
  | { ok: true; artifact: ConsentArtifact; ageDays: number; stale: boolean }
  | { ok: false; reason: string };

/** Consent older than this is flagged for re-confirmation. Numbers get
 *  reassigned, and a stale record is a weaker defence. Not a hard block: the
 *  caller decides whether to re-engage or suppress. */
const STALE_AFTER_DAYS = 365;

function nonEmpty(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s.length > 0 ? s : null;
}

/**
 * Parse and validate a stored artifact. Every required field must be present
 * and non-empty; a partial record is treated as no record.
 */
export function readConsentArtifact(raw: unknown, nowMs: number): ConsentVerdict {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "no_consent_artifact" };
  }
  const r = raw as Record<string, unknown>;

  const disclosureText = nonEmpty(r.disclosure_text ?? r.disclosureText);
  const sellerNamed = nonEmpty(r.seller_named ?? r.sellerNamed);
  const capturedAt = nonEmpty(r.captured_at ?? r.capturedAtIso ?? r.timestamp);

  if (!disclosureText) return { ok: false, reason: "missing_disclosure_text" };
  if (!sellerNamed) return { ok: false, reason: "missing_seller_named" };
  if (!capturedAt) return { ok: false, reason: "missing_timestamp" };

  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return { ok: false, reason: "unparseable_timestamp" };
  // A timestamp in the future is a corrupt or fabricated record. Refuse it
  // rather than treating it as freshly captured.
  if (t > nowMs + 86_400_000) return { ok: false, reason: "timestamp_in_future" };

  const methodRaw = String(r.method ?? "unknown").trim().toLowerCase();
  const method: ConsentMethod = (
    ["web_form", "verbal", "imported", "api"].includes(methodRaw) ? methodRaw : "unknown"
  ) as ConsentMethod;

  const ageDays = Math.floor((nowMs - t) / 86_400_000);

  return {
    ok: true,
    artifact: {
      disclosureText,
      sellerNamed,
      capturedAtIso: new Date(t).toISOString(),
      sourceUrl: nonEmpty(r.source_url ?? r.sourceUrl),
      ipAddress: nonEmpty(r.ip ?? r.ipAddress),
      method,
      disclosureVersion: nonEmpty(r.disclosure_version ?? r.disclosureVersion),
    },
    ageDays,
    stale: ageDays > STALE_AFTER_DAYS,
  };
}

export type SmsGateInput = {
  /** The stored artifact, from lead data. */
  consent: unknown;
  /** Suppressed on ANY brand or channel. Brand-blind by design. */
  suppressed: boolean;
  optedOut: boolean;
  /** Verified mobile. Landlines are a permanent failure and MCA lists are
   *  landline-heavy, so this is a real filter, not a formality. */
  lineType: "mobile" | "landline" | "voip" | "unknown";
  /** SMS already sent to this person in the rolling 24h. Law caps this at 3
   *  on the same subject in FL, MD and OK; applied nationally. */
  sentLast24h: number;
  nowMs: number;
};

export type SmsGateVerdict = { allow: true; artifact: ConsentArtifact } | { allow: false; reason: string };

/**
 * May we text this person right now?
 *
 * Order matters. Opt-out and suppression are checked FIRST and are absolute:
 * no consent artifact, however well documented, overrides someone asking to
 * stop. Everything after that is the affirmative case for sending.
 */
export function smsGate(input: SmsGateInput): SmsGateVerdict {
  if (input.optedOut) return { allow: false, reason: "opted_out" };
  if (input.suppressed) return { allow: false, reason: "suppressed" };

  const verdict = readConsentArtifact(input.consent, input.nowMs);
  if (!verdict.ok) return { allow: false, reason: verdict.reason };

  // Landlines cannot receive SMS; VOIP and unknown are refused because we
  // cannot prove deliverability and a permanent failure is a carrier signal.
  if (input.lineType !== "mobile") {
    return { allow: false, reason: `line_type_${input.lineType}` };
  }

  if (input.sentLast24h >= 3) return { allow: false, reason: "frequency_cap_24h" };

  return { allow: true, artifact: verdict.artifact };
}
