/**
 * lib/drips/ai-wire-core.ts — the AI Follow-Up wire.
 *
 * Adon, 2026-08-14: "There should be a sub-account called AI Follow-Up Account.
 * That's gonna be the sub-account that we use for the Live Subs follow-ups."
 *
 * WHAT THIS IS. A fourth wire, alongside jordan / alex / admin, on a DIFFERENT
 * TextTorrent parent account:
 *
 *   parent      Legacy Funding, submissions@fundwithlegacy.com   (id 1270)
 *   sub-account AI Follow-Up,   submissions@sunbizfunding.com    (id 1522)
 *   numbers     +19703237557 (CO), +16505977482 (CA)
 *
 * VERIFIED live 2026-08-14 against the TT API: acting as
 * submissions@sunbizfunding.com on the Legacy SID returns account 1522, and the
 * numbers endpoint reports both DIDs as purchased_by "AI Follow-Up" under
 * user_id 1522. Acting as an email that is NOT a real sub-account returns 401
 * rather than silently falling through to the parent — so a typo here fails
 * closed instead of texting merchants from the wrong company's number.
 *
 * WHY A SEPARATE ACCOUNT AT ALL. The three existing wires are all on the main
 * SunBiz SID, and as of 2026-08-14 the carrier is refusing essentially
 * everything from them: 19 consecutive failures across six numbers, every one
 * returning HTTP 201 as if it had worked. These two DIDs have never sent, so
 * they are unburned. Keeping them on their own parent SID also gives them their
 * own 60/min rate budget.
 *
 * SCOPE IS DELIBERATELY NARROW. Live Subs only, confirmed with Adon 2026-08-14
 * against the alternative of moving every drip here. Jordan and Alex keep their
 * own numbers for their own leads, which is the rule he set on 2026-08-13
 * ("three separate wires... not all of them using one number"). Widening it is
 * an env change, not a code change — see DRIP_AI_WIRE_STAGES.
 *
 * Pure and free of "server-only" so the rule that decides which company's number
 * appears on a merchant's phone is directly testable.
 */

/** Live Subs. The stage is `uw_sheet` in the data model; "Live Subs" is the UI
 *  name for the same thing, and both spellings appear in imported records. */
const DEFAULT_AI_WIRE_STAGES = ["uw_sheet", "live_sub", "live_subs"];

export const AI_WIRE_REP_KEY = "ai_followup";
export const AI_WIRE_SERVICE = "texttorrent_followup";
export const AI_WIRE_ACT_AS = "submissions@sunbizfunding.com";

/** VERIFIED live 2026-08-14. Overridable because TT numbers are bought and
 *  burned roughly weekly (Adon, 2026-08-13) and a rotation must not need a
 *  deploy. The live sms_sender_numbers table is consulted first at the call
 *  site; this is the floor beneath it. */
const DEFAULT_AI_WIRE_NUMBERS = ["+19703237557", "+16505977482"];

const E164_RE = /^\+[1-9][0-9]{9,14}$/;

/**
 * Which stages route to the AI wire.
 *
 * Read at call time rather than module load so the scope can widen without a
 * deploy. `DRIP_AI_WIRE_STAGES=*` puts every drip on this account, which is the
 * option Adon deferred rather than rejected.
 */
export function aiWireStages(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.DRIP_AI_WIRE_STAGES || "").trim();
  if (!raw) return DEFAULT_AI_WIRE_STAGES;
  if (raw === "*") return ["*"];
  const parsed = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // An override that parses to nothing is a typo, not an instruction to route
  // nowhere. Fail closed to the verified defaults rather than silently
  // switching the wire off.
  return parsed.length > 0 ? parsed : DEFAULT_AI_WIRE_STAGES;
}

/** The AI wire's sending numbers, with an env override for rotation. */
export function aiWireNumbers(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.DRIP_AI_WIRE_NUMBERS || "").trim();
  if (!raw) return DEFAULT_AI_WIRE_NUMBERS;
  const parsed = raw.split(",").map((s) => s.trim()).filter((n) => E164_RE.test(n));
  // Same fail-closed rule as the stages, and for a sharper reason: an empty
  // pool here would block every Live Sub text with rep_has_no_line, turning a
  // fat-fingered env var into a silent outage on the one wire that works.
  return parsed.length > 0 ? parsed : DEFAULT_AI_WIRE_NUMBERS;
}

/**
 * Does this lead's SMS go out on the AI Follow-Up wire?
 *
 * Stage-driven, not rep-driven, because "Live Subs" is a stage and the leads in
 * it carry whatever rep happened to import them. Routing on the rep would send
 * some live subs down the burned wires and split the cohort in half.
 */
export function usesAiWire(
  data: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const stages = aiWireStages(env);
  if (stages.includes("*")) return true;
  const stage = String(data.stage ?? "").trim().toLowerCase();
  if (!stage) return false;
  return stages.includes(stage);
}

/**
 * Stages that may ONLY be reached by SMS.
 *
 * Adon, 2026-08-17: "that's why live subs is going to be just SMS only."
 *
 * WHY THIS NEEDS ITS OWN RULE rather than relying on the cohort having no email
 * addresses. Two separate mechanisms will silently turn an SMS step into an
 * email if you let them:
 *
 *   resolveChannel   substitutes the other channel when the authored one has no
 *                    contact detail — Adon's 2026-08-10 rule, correct
 *                    everywhere else.
 *   onProviderGap    falls back to email when SMS is blocked upstream — added
 *                    2026-08-14 to break the hold loops, also correct
 *                    everywhere else.
 *
 * Both already fire in production: 127 rows carry channel='sms' with an EMAIL
 * address in from_identity, going back to 2026-07-20. On Live Subs that is not
 * a helpful fallback, it is a violation of the instruction.
 *
 * DELIBERATELY NOT DERIVED from a "does this lead have an email" check. Only 1
 * of the 86 Live Subs has one today, so a data-driven guard would look like it
 * worked and then break the first time someone enriches the cohort.
 *
 * Defaults to the AI-wire stages because they are the same cohort by
 * construction — Live Subs text from the AI Follow-Up wire and are not emailed.
 * Separately overridable so the two can be decoupled without a deploy if that
 * ever stops being true.
 */
export function smsOnlyStages(env: Record<string, string | undefined> = process.env): string[] {
  const raw = (env.DRIP_SMS_ONLY_STAGES || "").trim();
  if (raw === "none") return [];
  if (!raw) return aiWireStages(env).filter((s) => s !== "*");
  const parsed = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // A typo must not silently drop the restriction and start emailing a cohort
  // that was explicitly declared SMS-only. Clearing it takes the literal word
  // "none", which cannot be typed by accident.
  return parsed.length > 0 ? parsed : aiWireStages(env).filter((s) => s !== "*");
}

/** Is this lead in a stage we are forbidden to email? */
export function isSmsOnly(
  data: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const stage = String(data.stage ?? "").trim().toLowerCase();
  if (!stage) return false;
  return smsOnlyStages(env).includes(stage);
}
