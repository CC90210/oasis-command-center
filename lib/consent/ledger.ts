/**
 * lib/consent/ledger.ts — the insert-only consent ledger (`consent_events`,
 * database/turso/bravo__214_consent_events.sql): recording a decision, and
 * the one gate every marketing send must pass.
 *
 * WHY A SEPARATE LEDGER FROM OPT-IN VAULT. lib/consent/optinvault.ts seals
 * evidence for SunBiz and Bluerise only (lib/consent/brand-for-tenant.ts: a
 * tenant not on that list captures NOTHING). Every other workspace's public
 * form — including OASIS's own /ai-audit — asked for a mobile number with no
 * consent record at all. This table is first-party (no external vault call,
 * no site key), scoped to every workspace, and additive: SunBiz and Bluerise
 * keep the vault exactly as it is.
 *
 * SERVER OWNS THE TRUTH. recordConsentEvents takes the CHANNELS the caller
 * (the submit route) has already determined this form step actually
 * rendered — derived from the form's OWN field definitions, never from
 * anything the client claims — and the IDENTITY the server resolved
 * (lib/consent/ledger-identity.ts). It renders the disclosure text itself and
 * hashes that. A client cannot add a channel that was not on the step, and
 * cannot alter the text or the hash: nothing it sends is read for either.
 *
 * CONSENT BELONGS TO A DESTINATION, NOT A LEAD. Every row carries
 * subject_hash: sha256 of the channel plus the normalised email/number the
 * step's own field held (lib/consent/ledger-disclosure.ts
 * normalizeConsentSubject). The send gate matches the address it is about to
 * use against that, across every lead in the workspace. A lead-keyed answer
 * would let consent given for one number authorise another — an anonymous
 * submission can merge into an existing lead by business name alone. The
 * hash is a match key, not secrecy (phone numbers are enumerable); the raw
 * value lives on the lead row, which unlike this table can be erased.
 *
 * FAIL CLOSED, BOTH DIRECTIONS.
 *   - A failed TICK write does not fail the submission (the enquiry is still
 *     answered — the house rule this mirrors is lib/consent/optinvault.ts's
 *     "a rejected capture must never be recorded locally as consent"). No
 *     ticked row means the gate refuses, so the only cost is the ability to
 *     market to that destination until they tick again.
 *   - A failed DECLINE write is different when it is a WITHDRAWAL: an earlier
 *     tick would stay the latest answer and keep allowing marketing.
 *     unrecordedWithdrawal reports that case (or the case where it cannot
 *     tell), and the submit route refuses the submission so the visitor's
 *     "no" is retried rather than silently lost.
 *   - A READ failure (hasTickedConsent) returns false: no proof of consent,
 *     so no send. The one thing this module must never do is turn "I could
 *     not check" into "they said yes".
 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dbBool } from "@/lib/db-bool";
import { redactSubmissionPath } from "@/lib/forms/lead-source";
import {
  CONSENT_DISCLOSURE_VERSION,
  consentDisclosureText,
  normalizeConsentSubject,
  type ConsentChannel,
  type ConsentIdentity,
} from "./ledger-disclosure";
import type { ConsentIdentitySource } from "./ledger-identity";

export type ConsentDecision = {
  channel: ConsentChannel;
  /** Whether THIS box was ticked. Recorded either way — a recorded decline is
   *  itself the evidence that unticks a channel for marketing. */
  ticked: boolean;
  /** The normalised destination the step's own field held, or null when the
   *  field was blank. A null-subject row is evidence of what was shown, but
   *  can never authorise a send. */
  subject: string | null;
};

export type RecordConsentEventsInput = {
  tenantId: string;
  leadId: string;
  formId: string;
  /** Only channels the SERVER determined this step actually rendered — see
   *  the module doc. Never derived from client input. */
  decisions: ConsentDecision[];
  identity: ConsentIdentity;
  identitySource: ConsentIdentitySource;
  /** From Cloudflare's cf-connecting-ip header. Never from the request body —
   *  a client can set any value it likes in a JSON field, which would make
   *  this evidence worthless against the one party it exists to bind. */
  ipAddress: string | null;
  userAgent: string | null;
  /** Token-free page address (see consentPageUrl in the submit route). */
  pageUrl: string | null;
};

export type RecordConsentEventsResult = {
  ok: boolean;
  /** Channels that recorded successfully. */
  recorded: ConsentChannel[];
  /** Decisions that were asked for but failed to write, with why. */
  failed: Array<ConsentDecision & { reason: string }>;
};

/**
 * What the ledger says about one destination on one channel:
 *   ticked    — consented, and has never declined since: marketing allowed.
 *   withdrawn — consented, then declined: refused, and a later tick does NOT
 *               revive it (see consentState).
 *   declined  — has only ever declined (or left the box unticked).
 *   none      — never asked.
 *   unknown   — the read failed; callers treat it as the worst case.
 */
export type ConsentState = "ticked" | "withdrawn" | "declined" | "none" | "unknown";

/** Rows read per destination. A destination with more than this many
 *  decisions answers "unknown" rather than a guess from a partial history. */
const CONSENT_HISTORY_CAP = 500;

/** sha256 of the exact rendered text, hex-encoded. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The page address stored on a consent row, with no credential in it.
 * `rawPath` is the client's submission_path, which on the token route is
 * `/f/<tenant>/<form>/<SIGNED TOKEN>` — a live bearer credential for that
 * lead's form. This table can never be edited or deleted, so a token written
 * here could never be removed. The signed segment is replaced, any query or
 * fragment is dropped, and anything that is not a plain same-site path falls
 * back to the server-built form address.
 */
export function consentPageUrl(origin: string, rawPath: string | null | undefined, fallbackPath: string): string {
  const redacted = redactSubmissionPath(rawPath);
  const path = redacted ? redacted.split(/[?#]/)[0] : "";
  const safe = path.startsWith("/") && !path.startsWith("//") ? path : fallbackPath;
  return `${origin}${safe}`;
}

/** The match key a decision is stored and looked up under. */
export function consentSubjectHash(channel: ConsentChannel, subject: string): string {
  return sha256Hex(`${channel}:${subject}`);
}

/**
 * Insert one row per decision. Never throws — a ledger outage must not break
 * the enquiry it is recording consent for. Each row is attempted
 * independently so one failure does not lose a sibling channel's record.
 */
export async function recordConsentEvents(
  db: SupabaseClient,
  input: RecordConsentEventsInput,
): Promise<RecordConsentEventsResult> {
  const recorded: ConsentChannel[] = [];
  const failed: Array<ConsentDecision & { reason: string }> = [];
  const now = new Date().toISOString();

  for (const decision of input.decisions) {
    const text = consentDisclosureText(decision.channel, input.identity);
    const hash = sha256Hex(text);
    try {
      const ins = await db.from("consent_events").insert({
        id: randomUUID(),
        tenant_id: input.tenantId,
        lead_id: input.leadId,
        form_id: input.formId,
        channel: decision.channel,
        ticked: decision.ticked ? 1 : 0,
        subject_hash: decision.subject ? consentSubjectHash(decision.channel, decision.subject) : null,
        disclosure_hash: hash,
        disclosure_version: CONSENT_DISCLOSURE_VERSION,
        disclosure_text: text,
        ip_address: input.ipAddress,
        user_agent: input.userAgent,
        page_url: input.pageUrl,
        identity_source: input.identitySource,
        created_at: now,
      });
      if (ins.error) {
        failed.push({ ...decision, reason: ins.error.message });
        console.error("[consent.ledger] insert failed", {
          tenant_id: input.tenantId,
          lead_id: input.leadId,
          channel: decision.channel,
          error: ins.error.message,
        });
      } else {
        recorded.push(decision.channel);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ ...decision, reason });
      console.error("[consent.ledger] insert threw", {
        tenant_id: input.tenantId,
        lead_id: input.leadId,
        channel: decision.channel,
        error: reason,
      });
    }
  }

  return { ok: failed.length === 0, recorded, failed };
}

/**
 * Classify a destination's decisions, oldest first. Pure, so the rule is
 * testable without a database.
 *
 * A WITHDRAWAL IS PERMANENT. Once a tick is followed by any decline, the
 * answer is "withdrawn" no matter what comes after. Consent is keyed on the
 * address, and a public form lets anyone type anyone's address: if the latest
 * row simply won, a stranger could tick a box with your email and undo the
 * opt-out you gave. Re-consent after a withdrawal therefore needs a verified
 * path (a confirmation the address itself answers), which this ledger does not
 * provide; until it exists, a withdrawn destination stays refused. Declines
 * BEFORE the first tick are only ever "did not opt in" and do not block a
 * later tick. Rows sharing a timestamp are read tick-first, so a "no"
 * recorded at the same instant as a "yes" counts as coming after it.
 */
export function classifyConsentHistory(rows: ReadonlyArray<{ ticked?: unknown }>): ConsentState {
  if (rows.length === 0) return "none";
  const firstTick = rows.findIndex((r) => dbBool(r.ticked));
  if (firstTick < 0) return "declined";
  const declinedSince = rows.slice(firstTick + 1).some((r) => !dbBool(r.ticked));
  return declinedSince ? "withdrawn" : "ticked";
}

/**
 * The ledger's answer for this destination on this channel, in this
 * workspace, across every lead (classifyConsentHistory has the rule).
 * "unknown" means the read failed or the history was too long to read whole.
 */
export async function consentState(
  db: SupabaseClient,
  args: { tenantId: string; channel: ConsentChannel; destination: unknown },
): Promise<ConsentState> {
  const subject = normalizeConsentSubject(args.channel, args.destination);
  if (!subject) return "none";
  try {
    const res = await db
      .from("consent_events")
      .select("ticked, created_at")
      .eq("tenant_id", args.tenantId)
      .eq("channel", args.channel)
      .eq("subject_hash", consentSubjectHash(args.channel, subject))
      .order("created_at", { ascending: true })
      .order("ticked", { ascending: false })
      .limit(CONSENT_HISTORY_CAP);
    if (res.error) {
      console.error("[consent.ledger] consent read failed", {
        tenant_id: args.tenantId,
        channel: args.channel,
        error: res.error.message,
      });
      return "unknown";
    }
    const rows = (res.data || []) as Array<{ ticked?: unknown }>;
    if (!Array.isArray(rows) || rows.length >= CONSENT_HISTORY_CAP) return "unknown";
    return classifyConsentHistory(rows);
  } catch (err) {
    console.error("[consent.ledger] consent read threw", {
      tenant_id: args.tenantId,
      channel: args.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unknown";
  }
}

/**
 * May this channel be used for a MARKETING send to this destination?
 *
 * Only "ticked" allows. No row at all (never asked, or the ask failed to
 * record) refuses, same as a decline: the absence of evidence is not evidence
 * of consent. A withdrawal refuses for good. A read error refuses — a send
 * that cannot prove consent is exactly the CASL/TCPA failure mode this ledger
 * exists to prevent.
 */
export async function hasTickedConsent(
  db: SupabaseClient,
  args: { tenantId: string; channel: ConsentChannel; destination: unknown },
): Promise<boolean> {
  return (await consentState(db, args)) === "ticked";
}

/**
 * Did a recording leave a WITHDRAWAL unrecorded? True when a decline failed
 * to write for a destination whose latest decision is still a tick, or whose
 * latest decision cannot be read. The submit route refuses the submission in
 * that case so the "no" is retried instead of the old "yes" standing.
 */
export async function unrecordedWithdrawal(
  db: SupabaseClient,
  tenantId: string,
  result: RecordConsentEventsResult,
): Promise<boolean> {
  for (const f of result.failed) {
    if (f.ticked || !f.subject) continue;
    const state = await consentState(db, { tenantId, channel: f.channel, destination: f.subject });
    if (state === "ticked" || state === "unknown") return true;
  }
  return false;
}
