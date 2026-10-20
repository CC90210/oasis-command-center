/**
 * lib/consent/lead-consent-flags.ts — which writes would make a person who told
 * us to stop contactable again.
 *
 * Pure, with no imports: the rule itself, so every writer asks the same
 * question and the test can drive it without a database. Writers do not call
 * it directly; they go through guardConsentLift (lib/consent/consent-lift.ts),
 * which adds who may lift and the record a lift leaves. Those writers are
 * lib/manifest/data.ts (updateRecord), app/api/leads/[id]/set-field and
 * lib/workflow-steps/record-crud.ts.
 *
 * WHAT IS PROTECTED. A lead's data carries markers the gates read:
 *
 *   dnc                           the call queue (lib/web-leads/claim.ts, assign.ts)
 *   opted_out                     the drip engine (lib/drips/enroller.ts, executor.ts)
 *                                 and the outbound gateway (BEA send_gateway.py)
 *   sms_opt_out, email_opt_out    the drip engine
 *   stage === "opted_out"         the drip engine
 *   status === "opted_out"        the outbound gateway (BEA send_guards.py)
 *   sms_opt_out_at                the email cool-off after a text STOP
 *                                 (lib/drips/optout-cooloff-core.ts)
 *
 * No code path legitimately clears one. Before this file nothing stopped an
 * editor, an AI action, a bulk move or a bridge write from doing it.
 *
 * WHAT "LIFT" MEANS. A write lifts a marker when ANY gate that reads it would
 * flip from suppressing to not suppressing. The gates do not read a flag the
 * same way, and the differences matter:
 *
 *   the call queue        dnc is `true` or `1` (the 1 libSQL returns). The
 *                         string "true" is NOT dnc there, so overwriting a real
 *                         true with "true" would quietly re-open the queue.
 *   the drip engine       `true`, "true", `1`, "1" (isTruthyFlag).
 *   the outbound gateway  opted_out is a real `true` and nothing else.
 *
 * so each flag keeps the list of readings of the gates that read IT, and a
 * write lifts the flag as soon as one of them flips. tests/consent-flags-stay-
 * set.test.ts evaluates the OCC gates' own source text against this file, so a
 * gate that changes its reading fails the test until this file follows. The
 * stage and status markers are compared exactly (`=== "opted_out"`), as both
 * gates compare them. The stamp is lifted when it is cleared or moved EARLIER,
 * because either ends the cool-off sooner; an unreadable stamp is left to the
 * executor, which repairs it to "now" on its own.
 *
 * Setting a marker, restating one, or changing any other field lifts nothing.
 */

export const CONSENT_FLAG_KEYS = ["dnc", "opted_out", "sms_opt_out", "email_opt_out"] as const;
type ConsentFlagKey = (typeof CONSENT_FLAG_KEYS)[number];

/** Fields that can hold the opted-out marker. Leads carry it on `stage`; the
 *  outbound gateway reads `status`; an application's pipeline field is `status`. */
const CONSENT_MARKER_FIELDS = ["stage", "status"] as const;
const OPTED_OUT_MARKER = "opted_out";

/** When the person texted STOP; the email cool-off runs from it. */
const CONSENT_STAMP_KEY = "sms_opt_out_at";

/** Record types that carry these markers. Offers, funded deals and the rest
 *  may use the word "stage" for something else and are not touched. */
const CONSENT_BEARING_ENTITIES: ReadonlySet<string> = new Set(["lead", "application"]);
export function isConsentBearingEntity(entity: string): boolean {
  return CONSENT_BEARING_ENTITIES.has(entity);
}

/** The RecordsError code, and the HTTP error code of every route that refuses. */
export const CONSENT_FLAG_LOCKED = "consent_flag_locked";
export const CONSENT_FLAG_LOCKED_MESSAGE =
  "This lead asked not to be contacted. Only a workspace owner or admin can lift that, and it is recorded.";

/** The 409 body a route answers a refused lift with, so every route says it the same way. */
export function consentLockedBody(fields: readonly string[]) {
  return { ok: false as const, error: CONSENT_FLAG_LOCKED, message: CONSENT_FLAG_LOCKED_MESSAGE, fields };
}

/** An authorised lift whose record could not be written is not made. */
export const CONSENT_LIFT_NOT_RECORDED = "consent_lift_not_recorded";
export const CONSENT_LIFT_NOT_RECORDED_MESSAGE =
  "That change was not saved because it could not be recorded. Try again in a moment.";

type Reading = (value: unknown) => boolean;

/** lib/drips/enroller.ts and executor.ts: isTruthyFlag. */
const dripEngine: Reading = (v) => v === true || v === "true" || v === 1 || v === "1";
/** lib/web-leads/claim.ts factsFrom and assign.ts isDnc. */
const callQueue: Reading = (v) => v === true || v === 1;
/** BEA scripts/integrations/send_gateway.py: lead_data.get("opted_out") is True. */
const outboundGateway: Reading = (v) => v === true;

const FLAG_READINGS: Record<ConsentFlagKey, readonly Reading[]> = {
  dnc: [callQueue],
  opted_out: [dripEngine, outboundGateway],
  sms_opt_out: [dripEngine],
  email_opt_out: [dripEngine],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const hasStamp = (v: unknown): boolean => !(v === null || v === undefined || v === "");

/** The stamp as an instant, read the way emailCooloff reads it; null when unreadable. */
function stampInstant(v: unknown): number | null {
  if (!hasStamp(v)) return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function stampLifted(before: unknown, after: unknown): boolean {
  if (!hasStamp(before)) return false;
  if (!hasStamp(after)) return true;
  const was = stampInstant(before);
  const now = stampInstant(after);
  return was !== null && now !== null && now < was;
}

/**
 * The marker keys a write from `before` to `after` would lift: the flags in
 * CONSENT_FLAG_KEYS order, then `stage` and `status`, then the stamp. Empty
 * when the write lifts nothing. `after` is the WHOLE next document, so a key
 * that is missing from it counts as cleared, and so does a document that is
 * not an object.
 */
export function liftedConsentKeys(before: unknown, after: unknown): string[] {
  const was = asRecord(before);
  const now = asRecord(after);
  const lifted: string[] = [];
  for (const key of CONSENT_FLAG_KEYS) {
    if (FLAG_READINGS[key].some((reads) => reads(was[key]) && !reads(now[key]))) lifted.push(key);
  }
  for (const field of CONSENT_MARKER_FIELDS) {
    if (was[field] === OPTED_OUT_MARKER && now[field] !== OPTED_OUT_MARKER) lifted.push(field);
  }
  if (stampLifted(was[CONSENT_STAMP_KEY], now[CONSENT_STAMP_KEY])) lifted.push(CONSENT_STAMP_KEY);
  return lifted;
}

/** The same question for a shallow-merge patch, which is how every writer
 *  here applies one: `{ ...before, ...patch }`. A key the patch names with
 *  `undefined` overwrites the stored value and is dropped when the row is
 *  written, so it counts as cleared. */
export function liftedConsentKeysByPatch(before: unknown, patch: unknown): string[] {
  return liftedConsentKeys(before, { ...asRecord(before), ...asRecord(patch) });
}
