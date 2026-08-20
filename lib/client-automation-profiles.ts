/**
 * lib/client-automation-profiles.ts — turn a finished onboarding into the
 * identity the shared classifier agent speaks as.
 *
 * THE MODEL. Every OASIS client site posts its contact form to ONE central
 * webhook, and ONE shared agent answers all of them, replying as that client's
 * brand. Per inbound post the agent needs "who am I right now?" — whose name,
 * services, hours, rules, and which humans get copied. That is a
 * `client_automation_profiles` row (database/148, database/turso/148). This
 * module is the only thing that creates one.
 *
 * WHAT IT DOES NOT DO. It does not activate the profile. Provisioning writes
 * status 'pending' and stops. The site has to actually exist and the ingest key
 * has to actually be installed before the agent starts answering a real
 * business's customers in that business's name — and only a human knows when
 * that is true. The two CHECK constraints on the table (an active profile needs
 * at least one CC address and a recorded consent) are the backstop, not the
 * policy.
 *
 * THE SECRET. Each client site authenticates its webhook posts with a per-site
 * ingest key. Only the SHA-256 of that key is ever stored. The raw key is
 * returned exactly once, from provisionClientAutomationProfile(), for the build
 * team to paste into the client's site. It is never logged here, and it cannot
 * be recovered — a lost key is re-issued, not looked up.
 *
 * FAIL LOUD, AND ALL AT ONCE. buildClientProfileDraft() collects every problem
 * it finds and throws them together in one ProfileDraftError. An operator
 * fixing a client's intake should see all four bad addresses in one pass, not
 * discover them one re-run at a time.
 *
 * WHO THE REPLY IS FROM IS A DECISION, NOT A STRING (149). The address alone
 * never said whether this client shares OASIS's sender reputation with everyone
 * else or stands on its own domain, so reply_identity_mode now records which,
 * the address is validated against it, and per_client_domain cannot be activated
 * before its DNS is verified. The rules and the tradeoffs live in
 * lib/reply-identity.ts; this module supplies the operator's answer to them.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getServiceSupabase } from "./supabase-server";
import { dbError } from "./db-error";
import {
  canActivateProfile,
  isReplyIdentityMode,
  resolveReplyIdentity,
  REPLY_IDENTITY_MODE_IDS,
  REPLY_IDENTITY_MODES_REQUIRING_DNS,
  type ReplyIdentityMode,
} from "./reply-identity";
import {
  CLIENT_ONBOARDING_CONSENT_TEXT,
  CLIENT_ONBOARDING_SLUG,
  CLIENT_ONBOARDING_STEP_COUNT,
} from "./forms/oasis-client-onboarding-seed";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

export type ClientAutomationProfileStatus = "pending" | "active" | "paused";

export type ClientAutomationProfile = {
  id: string;
  tenant_id: string;
  onboarding_id: string | null;
  lead_id: string | null;
  client_name: string;
  website_domain: string;
  industry: string | null;
  icp_track: string | null;
  mission_summary: string | null;
  brand_voice: string | null;
  reply_tone: "formal" | "professional" | "friendly" | "casual";
  services: string[];
  prohibited_claims: string[];
  reply_from_identity: string;
  /** Which sending-identity strategy this address is — see lib/reply-identity.ts.
   *  Never defaulted; an absent one is a rejected provision, not a guess. */
  reply_identity_mode: ReplyIdentityMode;
  /** When SPF/DKIM/DMARC were confirmed on the CLIENT's own domain. Only
   *  meaningful for per_client_domain, where NULL blocks activation. */
  dns_verified_at: string | null;
  cc_emails: string[];
  notification_emails: string[];
  primary_phone: string | null;
  business_hours: Record<string, unknown>;
  timezone: string;
  service_area: string | null;
  response_sla_minutes: number | null;
  ingest_key_hash: string;
  ingest_key_issued_at: string;
  ingest_key_rotated_at: string | null;
  ingest_key_last_used_at: string | null;
  approver_name: string | null;
  approver_email: string | null;
  send_consent_at: string | null;
  send_consent_name: string | null;
  send_consent_evidence: Record<string, unknown>;
  status: ClientAutomationProfileStatus;
  activated_at: string | null;
  paused_at: string | null;
  paused_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Everything buildClientProfileDraft() can derive from the client's answers.
 *
 * THIS Omit IS LOAD-BEARING: every column NOT listed here becomes a required
 * field on the draft, and therefore part of the INSERT. reply_identity_mode is
 * deliberately absent from the list — it must travel with the row. Whereas
 * dns_verified_at is listed: it records something an operator confirms about the
 * client's DNS days later, and nothing in an intake could ever imply it. A draft
 * that had to produce one would only ever produce a lie.
 */
export type ClientProfileDraft = Omit<
  ClientAutomationProfile,
  | "id"
  | "dns_verified_at"
  | "ingest_key_hash"
  | "ingest_key_issued_at"
  | "ingest_key_rotated_at"
  | "ingest_key_last_used_at"
  | "activated_at"
  | "paused_at"
  | "paused_reason"
  | "created_at"
  | "updated_at"
>;

/**
 * Every problem found in one intake, thrown together.
 *
 * `.problems` is the operator-facing list; the message joins them so a bare
 * `console.error(err)` or a caught `err.message` still carries all of it.
 */
export class ProfileDraftError extends Error {
  constructor(public readonly problems: string[]) {
    super(`client onboarding intake cannot be provisioned:\n  - ${problems.join("\n  - ")}`);
    this.name = "ProfileDraftError";
  }
}

// ---------------------------------------------------------------------------
// Normalization — domains
// ---------------------------------------------------------------------------

/**
 * Reduce whatever a client typed to the bare lowercase host the inbound webhook
 * will actually see. Returns null when there is no plausible host in there.
 *
 * THIS IS THE MATCH KEY FOR THE WHOLE SYSTEM. "https://Acme-Heating.com/contact"
 * and "acme-heating.com" are the same client; a row stored in the first form
 * would never match a real post, and the symptom reads as "the agent ignored my
 * client" rather than as a data error. The table's CHECK constraints reject the
 * un-normalized forms, so this function and those constraints have to agree.
 */
export function normalizeWebsiteDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  host = host.replace(/^[^/@]*@/, ""); // userinfo, if someone pasted a URL with one
  host = host.split("/")[0]; // path
  host = host.split("?")[0].split("#")[0];
  host = host.split(":")[0]; // port
  host = host.replace(/^www\./, "");
  host = host.replace(/\.+$/, ""); // trailing dot (root-label form)
  if (!host || host.length > 253) return null;
  // Labels: alphanumeric, inner hyphens, at least one dot, TLD >= 2 letters.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(host)) {
    return null;
  }
  return host;
}

// ---------------------------------------------------------------------------
// Normalization — emails
// ---------------------------------------------------------------------------

/**
 * Provider domains people fat-finger, mapped to what they meant.
 *
 * NOT a spell-checker and deliberately not clever: only exact matches on this
 * short list are rejected, and the rejection names the correction. The failure
 * being prevented is specific and expensive — a client typing "gmail.con" means
 * every automated reply about their own customers goes nowhere, silently,
 * forever, and the first anyone hears of it is the client asking why the
 * automation never worked.
 */
const MISTYPED_EMAIL_DOMAINS: Record<string, string> = {
  "gmail.con": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.cm": "gmail.com",
  "gmai.com": "gmail.com",
  "gmial.com": "gmail.com",
  "gmail.comm": "gmail.com",
  "gnail.com": "gmail.com",
  "hotmail.con": "hotmail.com",
  "hotmal.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmial.com": "hotmail.com",
  "yahoo.con": "yahoo.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "outlook.con": "outlook.com",
  "outlok.com": "outlook.com",
  "iclould.com": "icloud.com",
  "icloud.con": "icloud.com",
};

/**
 * Practical address validation. There is NO email validation anywhere in the
 * public form path — `<input type="email">` is a browser hint the submit route
 * never re-checks — so this is the first and only gate before an address
 * becomes the place a client's customer replies land.
 *
 * Returns the lowercased address, or a reason string explaining the rejection.
 * Deliberately stricter than RFC 5322: no quoted local parts, no comments, no
 * bare-IP domains. None of those appear in a small business's inbox, and every
 * one of them is more likely to be a paste accident than a real address.
 */
export function normalizeEmailAddress(raw: unknown): { email: string } | { reason: string } {
  if (typeof raw !== "string") return { reason: "not a string" };
  const value = raw.trim().toLowerCase();
  if (!value) return { reason: "empty" };
  if (value.length > 254) return { reason: "longer than 254 characters" };
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return { reason: `"${raw.trim()}" is missing a local part or a domain` };
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64) return { reason: `"${raw.trim()}" has a local part longer than 64 characters` };
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local)) {
    return { reason: `"${raw.trim()}" has an unusable local part` };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
    return { reason: `"${raw.trim()}" has an unusable domain` };
  }
  const corrected = MISTYPED_EMAIL_DOMAINS[domain];
  if (corrected) {
    return { reason: `"${raw.trim()}" looks like a typo — did they mean ${local}@${corrected}?` };
  }
  return { email: value };
}

/**
 * Parse the "one per line" textarea answers (and the single-email inputs) into
 * a clean, deduped, lowercased list.
 *
 * Rejections are RETURNED, not dropped. A silently discarded CC address is a
 * client who thinks they are being copied on every reply and is not — the exact
 * failure this whole table exists to prevent.
 */
export function parseEmailList(raw: unknown): { emails: string[]; rejected: string[] } {
  const candidates: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) if (typeof item === "string") candidates.push(item);
  } else if (typeof raw === "string") {
    candidates.push(...raw.split(/[\r\n,;]+/));
  }
  const emails: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.trim()) continue; // blank lines are not a mistake
    const result = normalizeEmailAddress(candidate);
    if ("reason" in result) {
      rejected.push(result.reason);
      continue;
    }
    if (seen.has(result.email)) continue;
    seen.add(result.email);
    emails.push(result.email);
  }
  return { emails, rejected };
}

// ---------------------------------------------------------------------------
// Normalization — free-text lists
// ---------------------------------------------------------------------------

/** Answers to "nothing to declare" on the never-say question. */
const EMPTY_LIST_ANSWERS = new Set(["nothing", "none", "n/a", "na", "no", "nope", "-", "—"]);

/**
 * "One per line" textarea → a clean string array.
 *
 * `allowExplicitNone` handles the escape hatch on the never-say question: the
 * field is required so a busy owner cannot skip it, and "nothing" is the honest
 * way to answer it. Treating that literal word as a prohibition would put
 * "never say nothing" into the agent's prompt.
 */
export function parseTextList(
  raw: unknown,
  opts: { maxItems?: number; maxItemLength?: number; allowExplicitNone?: boolean } = {},
): string[] {
  const maxItems = opts.maxItems ?? 25;
  const maxItemLength = opts.maxItemLength ?? 200;
  if (typeof raw !== "string") return Array.isArray(raw) ? parseTextList(raw.join("\n"), opts) : [];
  const trimmedWhole = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  if (opts.allowExplicitNone && EMPTY_LIST_ANSWERS.has(trimmedWhole)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/[\r\n]+/)) {
    const item = line.trim().replace(/^[-*•]\s*/, "").slice(0, maxItemLength).trim();
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingest key
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex of a raw ingest key — the only form that is ever persisted.
 *
 * Same construction as the invite tokens (lib/team.ts hashInviteToken) and the
 * signing tokens (lib/esign/tokens.ts sha256Hex): 32 random bytes, base64url,
 * hashed once with no salt. No salt is correct here and elsewhere: the input is
 * 256 bits of CSPRNG output, not a password, so there is no dictionary to
 * defend against and a per-row salt would only break the O(1) lookup the
 * webhook depends on.
 */
export function hashIngestKey(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Mint a fresh per-site ingest key.
 *
 * `raw` leaves this process exactly once — into the return value of
 * provisionClientAutomationProfile(), for a human to paste into the client's
 * site. Never log it, never store it, never put it in an error message.
 */
export function mintIngestKey(): { raw: string; hash: string } {
  const raw = `oasis_ing_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: hashIngestKey(raw) };
}

// ---------------------------------------------------------------------------
// Intake → draft
// ---------------------------------------------------------------------------

/** Options the CLIENT cannot supply — these are OASIS-side decisions. */
export type BuildProfileDraftOptions = {
  tenantId: string;
  /**
   * The OASIS-owned sending identity this client's replies go out as. REQUIRED
   * and never defaulted to a guess: which mailbox speaks for a real business is
   * an operator decision with deliverability and reputation consequences, and a
   * wrong default would be discovered by the client's customers.
   */
  replyFromIdentity: string;
  /**
   * WHICH KIND of sending identity that address is: shared_oasis,
   * per_client_subaddress, or per_client_domain. REQUIRED, with no default and
   * no inference from the address — the mode decides whose sender reputation
   * absorbs this client's spam complaints, and a guess would surface months
   * later as "our email stopped arriving", across unrelated clients.
   *
   * Typed as a plain string rather than the union because operators supply it
   * from a CLI or a provisioning form, where TypeScript is not a gate; the
   * check that matters is the runtime one below. lib/reply-identity.ts holds
   * what each id actually commits to.
   */
  replyIdentityMode: string;
  onboardingId?: string | null;
  leadId?: string | null;
  icpTrack?: string | null;
  createdBy?: string | null;
  /** When the client submitted the consent step — the consent timestamp. */
  consentAt?: string | null;
  /** Provenance recorded alongside the consent wording. */
  consentEvidence?: Record<string, unknown>;
};

const REPLY_TONES = new Set(["formal", "professional", "friendly", "casual"]);

function str(intake: Record<string, unknown>, key: string): string {
  const v = intake[key];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Build the row a completed onboarding implies. Pure — no I/O, no key minting,
 * no clock beyond the timestamps handed in. Throws ProfileDraftError listing
 * EVERY problem rather than the first one.
 */
export function buildClientProfileDraft(
  intake: Record<string, unknown>,
  opts: BuildProfileDraftOptions,
): ClientProfileDraft {
  const problems: string[] = [];

  if (!opts.tenantId?.trim()) problems.push("tenantId is required");
  const replyFrom = opts.replyFromIdentity?.trim() ?? "";
  if (!replyFrom) {
    problems.push(
      "replyFromIdentity is required — pass the OASIS sending identity explicitly " +
        "(there is no safe default for which mailbox speaks as a client's business)",
    );
  }

  // The mode is reported on its own, before the address is paired against it, so
  // an operator who omitted both is told about both rather than about whichever
  // check happened to run first.
  const modeRaw = typeof opts.replyIdentityMode === "string" ? opts.replyIdentityMode.trim() : "";
  if (!modeRaw) {
    problems.push(
      `replyIdentityMode is required — pass one of ${REPLY_IDENTITY_MODE_IDS.join(", ")} ` +
        "explicitly (the mode decides whether this client shares OASIS's sender reputation " +
        "with every other client or stands on its own domain; there is no safe default)",
    );
  } else if (!isReplyIdentityMode(modeRaw)) {
    problems.push(
      `replyIdentityMode "${modeRaw}" is not one of ${REPLY_IDENTITY_MODE_IDS.join(", ")}`,
    );
  }

  const clientName = str(intake, "business_name");
  if (!clientName) problems.push("business_name is empty — the agent has no name to sign replies with");

  const domain = normalizeWebsiteDomain(intake.website_domain);
  if (!domain) {
    const shown = str(intake, "website_domain");
    problems.push(
      shown
        ? `website_domain "${shown}" is not a usable domain — the inbound webhook matches on this exact value`
        : "website_domain is empty — the inbound webhook has nothing to match this client on",
    );
  }

  // ---- Does the address match the mode it was filed under? ----------------
  // Only askable once both halves are present and the client's own domain is
  // known, because per_client_domain is checked AGAINST that domain. Asking it
  // early would emit a second problem line about an address that was already
  // reported as missing.
  let replyIdentity: { mode: ReplyIdentityMode; address: string } | null = null;
  if (replyFrom && isReplyIdentityMode(modeRaw)) {
    const resolved = resolveReplyIdentity({
      mode: modeRaw,
      address: replyFrom,
      websiteDomain: domain,
    });
    if (resolved.ok) replyIdentity = { mode: resolved.mode, address: resolved.address };
    else problems.push(`reply identity rejected: ${resolved.error}`);
  }

  // ---- CC addresses: the transparency contract ----------------------------
  const primary = parseEmailList(intake.email);
  const additional = parseEmailList(intake.cc_emails_additional);
  problems.push(...primary.rejected.map((r) => `CC email rejected: ${r}`));
  problems.push(...additional.rejected.map((r) => `additional CC email rejected: ${r}`));
  const ccSeen = new Set<string>();
  const ccEmails: string[] = [];
  for (const e of [...primary.emails, ...additional.emails]) {
    if (ccSeen.has(e)) continue;
    ccSeen.add(e);
    ccEmails.push(e);
  }
  if (ccEmails.length === 0) {
    problems.push(
      "no usable CC address — the client would never see the replies sent in their name",
    );
  }

  const notify = parseEmailList(intake.notification_email);
  problems.push(...notify.rejected.map((r) => `notification email rejected: ${r}`));
  // Falls back to the CC list rather than to nobody: an urgent enquiry with no
  // destination is a silent drop.
  const notificationEmails = notify.emails.length > 0 ? notify.emails : ccEmails;

  const approverEmailRaw = str(intake, "approver_email");
  let approverEmail: string | null = null;
  if (approverEmailRaw) {
    const parsed = normalizeEmailAddress(approverEmailRaw);
    if ("reason" in parsed) problems.push(`approver email rejected: ${parsed.reason}`);
    else approverEmail = parsed.email;
  }

  // ---- Consent ------------------------------------------------------------
  const consentAnswer = str(intake, "send_consent");
  const consentName = str(intake, "consent_signed_name") || str(intake, "approver_name");
  let consentAt: string | null = null;
  if (consentAnswer === "agreed") {
    consentAt = opts.consentAt ?? new Date().toISOString();
    if (!consentName) {
      problems.push("consent was agreed but no name was typed — a consent record needs a person on it");
    }
  } else if (consentAnswer) {
    problems.push(`send_consent is "${consentAnswer}", not "agreed" — no authority to send on this client's behalf`);
  }
  // Not an error at draft time: a profile is provisioned at status 'pending',
  // and the table's CHECK constraint refuses to let it go 'active' without
  // consent. Missing consent blocks activation, not provisioning.

  const tone = str(intake, "reply_tone");
  const replyTone = REPLY_TONES.has(tone) ? (tone as ClientProfileDraft["reply_tone"]) : "professional";
  if (tone && !REPLY_TONES.has(tone)) {
    problems.push(`reply_tone "${tone}" is not one of formal/professional/friendly/casual`);
  }

  const slaRaw = str(intake, "response_speed");
  let responseSla: number | null = null;
  if (slaRaw) {
    const parsed = Number.parseInt(slaRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) responseSla = parsed;
    else problems.push(`response_speed "${slaRaw}" is not a positive number of minutes`);
  }

  const timezone = str(intake, "timezone");
  if (!timezone) {
    problems.push("timezone is empty — business hours without a timezone tell the agent nothing");
  }

  const hoursText = str(intake, "business_hours");

  if (problems.length > 0) throw new ProfileDraftError(problems);

  return {
    tenant_id: opts.tenantId.trim(),
    onboarding_id: opts.onboardingId ?? null,
    lead_id: opts.leadId ?? null,
    client_name: clientName,
    website_domain: domain as string,
    industry: str(intake, "industry") || null,
    icp_track: opts.icpTrack ?? null,
    mission_summary: str(intake, "what_you_do") || null,
    brand_voice: str(intake, "brand_voice") || null,
    reply_tone: replyTone,
    services: parseTextList(intake.top_services, { maxItems: 12 }),
    prohibited_claims: parseTextList(intake.never_say, { maxItems: 25, allowExplicitNone: true }),
    // Both come from the resolution rather than from the raw options: the
    // address is stored lowercased and mode-checked, so what the webhook later
    // sends as is exactly what was validated here. Non-null by this point —
    // any failure above threw, same as `domain` two fields up.
    reply_from_identity: (replyIdentity as { address: string }).address,
    reply_identity_mode: (replyIdentity as { mode: ReplyIdentityMode }).mode,
    cc_emails: ccEmails,
    notification_emails: notificationEmails,
    primary_phone: str(intake, "phone") || null,
    // Stored verbatim under `raw`, not parsed into a weekly schedule. A wrong
    // machine-read of "Mon-Fri 8-6, closed stat holidays" would have the agent
    // confidently promising a callback on Christmas Day; the raw sentence in
    // the prompt is both honest and better. Structured parsing is deferred to
    // an operator-editable schedule, not guessed here.
    business_hours: hoursText ? { raw: hoursText, source: "client_onboarding_form" } : {},
    timezone,
    service_area: str(intake, "service_area") || null,
    response_sla_minutes: responseSla,
    approver_name: str(intake, "approver_name") || null,
    approver_email: approverEmail,
    send_consent_at: consentAt,
    send_consent_name: consentAt ? consentName : null,
    // The exact wording the client agreed to, stored with the record. Consent
    // evidence that cannot reproduce what the person actually read is not
    // evidence — see CLIENT_ONBOARDING_CONSENT_TEXT.
    send_consent_evidence: consentAt
      ? {
          disclosure_text: CLIENT_ONBOARDING_CONSENT_TEXT,
          form_slug: CLIENT_ONBOARDING_SLUG,
          field: "send_consent",
          answer: consentAnswer,
          typed_name: consentName,
          ...(opts.consentEvidence ?? {}),
        }
      : {},
    status: "pending",
    created_by: opts.createdBy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reading the onboarding submission
// ---------------------------------------------------------------------------

/**
 * Merge a client's onboarding answers into one flat map.
 *
 * `form_submissions` holds ONE ROW PER STEP (app/api/forms/submit/route.ts
 * inserts per step, not per completion) with a payload keyed by field name.
 * Reading only the last row would return step 5's four fields and nothing else
 * — so the rows are merged in step order, later steps winning. Field names are
 * unique form-wide, so in practice nothing collides.
 */
export async function readOnboardingIntake(args: {
  tenantId: string;
  formId: string;
  leadId: string;
}): Promise<{ intake: Record<string, unknown>; stepsSubmitted: number; lastSubmittedAt: string | null }> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("form_submissions")
    .select("step_index, payload, submitted_at")
    .eq("tenant_id", args.tenantId)
    .eq("form_id", args.formId)
    .eq("lead_id", args.leadId)
    .order("step_index", { ascending: true });
  if (error) throw dbError("client_automation_profile.read_intake", error);

  const rows = (data ?? []) as Array<{
    step_index: number;
    payload: Record<string, unknown> | null;
    submitted_at: string | null;
  }>;
  const intake: Record<string, unknown> = {};
  let lastSubmittedAt: string | null = null;
  for (const row of rows) {
    Object.assign(intake, row.payload ?? {});
    if (row.submitted_at) lastSubmittedAt = row.submitted_at;
  }
  return { intake, stepsSubmitted: rows.length, lastSubmittedAt };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionResult = {
  profile: ClientAutomationProfile;
  /**
   * THE RAW INGEST KEY, RETURNED EXACTLY ONCE.
   *
   * Hand it to the person wiring the client's site and then drop it. It is not
   * recoverable from the database — only its SHA-256 is stored. Do not log it,
   * do not put it in a Telegram message, do not echo it into a build ticket
   * that outlives the deploy.
   */
  ingestKey: string;
};

/**
 * Create the pending profile for a client and issue their site's ingest key.
 *
 * Provisioning is deliberately an explicit operator action rather than a
 * side-effect of form submission: the bare /f/<tenant>/<slug> URL of any
 * enabled form is publicly fillable (there is no private-link-only mode in this
 * codebase), so auto-provisioning on submit would let anyone who found the link
 * mint a live automation identity pointed at a domain they do not own.
 */
export async function provisionClientAutomationProfile(
  intake: Record<string, unknown>,
  opts: BuildProfileDraftOptions,
): Promise<ProvisionResult> {
  const draft = buildClientProfileDraft(intake, opts);
  const key = mintIngestKey();
  const db = getServiceSupabase();

  const { data, error } = await db
    .from("client_automation_profiles")
    .insert({
      // Turso has no gen_random_uuid(); ids are supplied by the app on every
      // table in database/turso. Supplying it on both backends keeps one path.
      id: randomUUID(),
      ...draft,
      ingest_key_hash: key.hash,
    })
    .select("*")
    .maybeSingle();

  if (error) throw dbError("client_automation_profile.insert", error);
  if (!data) throw dbError("client_automation_profile.insert", null);

  return { profile: data as ClientAutomationProfile, ingestKey: key.raw };
}

/**
 * The whole path: a completed onboarding submission → a pending profile + a
 * freshly issued ingest key.
 *
 * Refuses a half-filled onboarding. Every step's answers are load-bearing, and
 * the last one is the consent — provisioning from a form abandoned at step 3
 * would mint an automation identity for a business that never granted OASIS
 * permission to speak for it. The error names how far they actually got, so the
 * operator chases the client rather than debugging the tool.
 *
 * The consent timestamp is the client's actual last submission time, not now():
 * evidence should say when they agreed, not when an operator got round to
 * provisioning.
 */
export async function provisionProfileFromOnboardingSubmission(args: {
  tenantId: string;
  formId: string;
  leadId: string;
  replyFromIdentity: string;
  /** Required, never defaulted — see BuildProfileDraftOptions.replyIdentityMode. */
  replyIdentityMode: string;
  onboardingId?: string | null;
  icpTrack?: string | null;
  createdBy?: string | null;
  /** Defaults to the seeded form's step count. */
  expectedSteps?: number;
}): Promise<ProvisionResult> {
  const expected = args.expectedSteps ?? CLIENT_ONBOARDING_STEP_COUNT;
  const { intake, stepsSubmitted, lastSubmittedAt } = await readOnboardingIntake({
    tenantId: args.tenantId,
    formId: args.formId,
    leadId: args.leadId,
  });
  if (stepsSubmitted < expected) {
    throw new ProfileDraftError([
      `onboarding is incomplete — ${stepsSubmitted} of ${expected} steps submitted` +
        (stepsSubmitted === 0 ? " (no submission found for this form and lead)" : ""),
    ]);
  }
  return provisionClientAutomationProfile(intake, {
    tenantId: args.tenantId,
    replyFromIdentity: args.replyFromIdentity,
    replyIdentityMode: args.replyIdentityMode,
    onboardingId: args.onboardingId ?? null,
    leadId: args.leadId,
    icpTrack: args.icpTrack ?? null,
    createdBy: args.createdBy ?? null,
    consentAt: lastSubmittedAt,
    consentEvidence: {
      form_id: args.formId,
      lead_id: args.leadId,
      steps_submitted: stepsSubmitted,
      submitted_at: lastSubmittedAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function loadProfile(id: string, tenantId: string): Promise<ClientAutomationProfile> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("client_automation_profiles")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.load", error);
  if (!data) throw new Error(`client_automation_profile ${id} not found for tenant ${tenantId}`);
  return data as ClientAutomationProfile;
}

/**
 * Turn the automation on for a client.
 *
 * A DELIBERATE, SEPARATE ACT. Provisioning writes 'pending' because the moment
 * this flips, a shared agent starts answering a real business's customers in
 * that business's name. Only a human knows the site is live and the ingest key
 * is actually installed.
 *
 * The two preconditions are re-checked here even though the table's CHECK
 * constraints enforce them, because a raw constraint violation names a
 * constraint and this names the missing thing. An operator who reads
 * "client_automation_profiles_active_needs_cc" has to go find the migration to
 * learn what to do about it.
 */
export async function activateClientAutomationProfile(args: {
  id: string;
  tenantId: string;
}): Promise<ClientAutomationProfile> {
  const current = await loadProfile(args.id, args.tenantId);
  const blockers: string[] = [];
  if (!Array.isArray(current.cc_emails) || current.cc_emails.length === 0) {
    blockers.push(
      "no CC address on the profile — the client would never see the replies sent in their name",
    );
  }
  if (!current.send_consent_at) {
    blockers.push(
      "no recorded consent — OASIS has no written authority to send email as this business",
    );
  }
  // THE DNS GATE (149). per_client_domain sends as a domain OASIS does not own,
  // so flipping this on before SPF/DKIM/DMARC exist puts unauthenticated mail
  // claiming to be the client into inboxes — and it is the client's domain, not
  // OASIS's, that gets scored down for it afterwards.
  const identity = canActivateProfile({
    mode: current.reply_identity_mode,
    dnsVerifiedAt: current.dns_verified_at,
  });
  if (!identity.ok) blockers.push(identity.error);
  if (blockers.length > 0) throw new ProfileDraftError(blockers);

  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("client_automation_profiles")
    .update({
      status: "active",
      activated_at: current.activated_at ?? now,
      paused_at: null,
      paused_reason: null,
      updated_at: now,
    })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("*")
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.activate", error);
  if (!data) throw dbError("client_automation_profile.activate", null);
  return data as ClientAutomationProfile;
}

/**
 * Stop the agent replying as this client, keeping the configuration intact.
 *
 * `reason` is required and stored. A paused automation is something a client
 * asked for or something that went wrong, and six weeks later nobody remembers
 * which — so an unexplained pause becomes a profile nobody dares turn back on.
 */
export async function pauseClientAutomationProfile(args: {
  id: string;
  tenantId: string;
  reason: string;
}): Promise<ClientAutomationProfile> {
  const reason = (args.reason ?? "").trim();
  if (!reason) throw new ProfileDraftError(["a pause needs a reason — an unexplained pause is never safely reversed"]);
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("client_automation_profiles")
    .update({ status: "paused", paused_at: now, paused_reason: reason.slice(0, 500), updated_at: now })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("*")
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.pause", error);
  if (!data) throw dbError("client_automation_profile.pause", null);
  return data as ClientAutomationProfile;
}

/**
 * Record that SPF, DKIM and DMARC were confirmed on the CLIENT's own domain —
 * the one thing that unblocks activating a per_client_domain profile.
 *
 * THIS RECORDS AN ATTESTATION. IT DOES NOT PERFORM A LOOKUP. Nothing here
 * queries DNS; a human checked the records and is signing that they did. The
 * distinction matters more than it looks: a function named for verification that
 * silently rubber-stamps would make the activation gate feel enforced while
 * being satisfied by anyone who called it, which is worse than no gate at all
 * because it reads as one. If a real resolver check is ever added, it belongs in
 * front of this call, not inside it.
 *
 * WITHOUT THIS THE GATE HAS NO KEY. canActivateProfile() refuses a
 * per_client_domain profile while dns_verified_at is null, and nothing else in
 * this codebase can set that column — so every client on their own domain would
 * be permanently un-activatable except by hand-written SQL against production.
 * A guard whose only remedy is a manual database edit is a trapdoor, not a
 * guard.
 *
 * `verifiedAt` is accepted so a check done yesterday is recorded as yesterday.
 * The inverse is deliberately not a function: migration 149 refuses to clear
 * dns_verified_at while the profile is active, so un-verifying means pausing
 * first — which is the correct order of operations anyway, since the reason to
 * un-verify is that the records stopped resolving and sending must stop.
 */
export async function recordDnsVerification(args: {
  id: string;
  tenantId: string;
  verifiedAt?: string | null;
}): Promise<ClientAutomationProfile> {
  const current = await loadProfile(args.id, args.tenantId);
  // Recording DNS verification against an OASIS-owned mode is a category error,
  // and refusing it names the misunderstanding: an operator doing this believes
  // the client's DNS gates a send that actually leaves from oasisai.work.
  if (!REPLY_IDENTITY_MODES_REQUIRING_DNS.has(current.reply_identity_mode)) {
    throw new ProfileDraftError([
      `this profile is on ${current.reply_identity_mode}, which sends from an OASIS-owned ` +
        "domain — there is no client DNS to verify, and nothing is blocking activation on it",
    ]);
  }
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("client_automation_profiles")
    .update({ dns_verified_at: args.verifiedAt?.trim() || now, updated_at: now })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("*")
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.record_dns", error);
  if (!data) throw dbError("client_automation_profile.record_dns", null);
  return data as ClientAutomationProfile;
}

/**
 * Issue a replacement ingest key, invalidating the old one immediately.
 *
 * THIS EXISTS BECAUSE THE ALTERNATIVE IS A TRAPDOOR. An ingest key gets pasted
 * into a client's website — the single most likely place for a secret to leak.
 * Without rotation the only remedy is deleting and re-provisioning the profile,
 * which throws away its id, its consent evidence, and its lead linkage: a
 * security incident would force the destruction of the very record that proves
 * the client authorized anything.
 *
 * The old key stops working the instant this returns, so the client's site is
 * posting with a dead key until someone installs the new one. Rotate when the
 * person who updates the site is ready, not when it is convenient to run.
 */
export async function rotateIngestKey(args: {
  id: string;
  tenantId: string;
}): Promise<{ profile: ClientAutomationProfile; ingestKey: string }> {
  const key = mintIngestKey();
  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("client_automation_profiles")
    .update({
      ingest_key_hash: key.hash,
      ingest_key_rotated_at: now,
      // The new key has never been used; carrying the old key's last-used
      // timestamp forward would make a dead credential look live.
      ingest_key_last_used_at: null,
      updated_at: now,
    })
    .eq("id", args.id)
    .eq("tenant_id", args.tenantId)
    .select("*")
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.rotate_key", error);
  if (!data) throw dbError("client_automation_profile.rotate_key", null);
  return { profile: data as ClientAutomationProfile, ingestKey: key.raw };
}

// ---------------------------------------------------------------------------
// Lookup (for the inbound webhook this table exists to serve)
// ---------------------------------------------------------------------------

/**
 * Resolve the profile a raw ingest key belongs to.
 *
 * THIS IS THE AUTHENTICATING LOOKUP — use it first. The key hash is unique
 * across the whole database, so it identifies exactly one client with no tenant
 * hint needed, and a caller that resolves by key cannot be steered by a forged
 * Host header. Returns null on any miss, including a malformed key.
 */
export async function findProfileByIngestKey(
  rawKey: string,
): Promise<ClientAutomationProfile | null> {
  const trimmed = (rawKey ?? "").trim();
  if (!trimmed) return null;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("client_automation_profiles")
    .select("*")
    .eq("ingest_key_hash", hashIngestKey(trimmed))
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.by_ingest_key", error);
  return (data as ClientAutomationProfile | null) ?? null;
}

/**
 * Resolve the profile for a website domain.
 *
 * NOT AN AUTHENTICATOR. A Host header is attacker-controlled; this answers
 * "which client claims this domain", which is a routing question and an
 * operator-lookup question, not an identity proof. The inbound webhook must
 * authenticate with findProfileByIngestKey() and then assert that the resolved
 * row's website_domain matches the posting site — never the other way round.
 *
 * Not tenant-scoped, on purpose: a webhook does not know the tenant until this
 * resolves. `unique (tenant_id, website_domain)` therefore permits the same
 * domain under two tenants; if that ever happens this returns the first match
 * and the caller must fall back to the key. See the open questions in the
 * migration header.
 */
export async function findProfileByWebsiteDomain(
  domain: string,
): Promise<ClientAutomationProfile | null> {
  const normalized = normalizeWebsiteDomain(domain);
  if (!normalized) return null;
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("client_automation_profiles")
    .select("*")
    .eq("website_domain", normalized)
    .in("status", ["active", "pending"])
    .limit(1)
    .maybeSingle();
  if (error) throw dbError("client_automation_profile.by_domain", error);
  return (data as ClientAutomationProfile | null) ?? null;
}
