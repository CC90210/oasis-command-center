/**
 * tests/client-automation-profiles.test.ts
 *
 * The onboarding form and the profile it produces are the two halves of one
 * contract: OASIS answers a client's customers, as the client, from an
 * OASIS-owned address, with the client copied. These pin the ways that contract
 * quietly stops holding — a CC address dropped instead of reported, a domain
 * stored in a shape the webhook can never match, a consent record that cannot
 * reproduce what the client actually read, and a field that asks a client for a
 * password the model is specifically designed never to need.
 */

import assert from "node:assert/strict";
import { parseFormSteps, parseFormBranding } from "../lib/forms/types";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";
import {
  CLIENT_ONBOARDING_STEPS,
  CLIENT_ONBOARDING_BRANDING,
  CLIENT_ONBOARDING_SLUG,
  CLIENT_ONBOARDING_CONSENT_TEXT,
  CLIENT_ONBOARDING_STEP_COUNT,
  buildClientOnboardingRow,
} from "../lib/forms/oasis-client-onboarding-seed";
import {
  normalizeWebsiteDomain,
  normalizeEmailAddress,
  parseEmailList,
  parseTextList,
  mintIngestKey,
  hashIngestKey,
  buildClientProfileDraft,
  pauseClientAutomationProfile,
  ProfileDraftError,
} from "../lib/client-automation-profiles";

// ---------------------------------------------------------------------------
// Form definition
// ---------------------------------------------------------------------------

const steps = parseFormSteps(CLIENT_ONBOARDING_STEPS);
parseFormBranding(CLIENT_ONBOARDING_BRANDING);
assert.equal(steps.length, 5, "five steps");
assert.equal(CLIENT_ONBOARDING_STEP_COUNT, 5, "step count is derived, not typed twice");
assert.deepEqual(
  steps.map((s) => s.key),
  ["replies", "business", "voice", "assets", "approval"],
  "step order: CCs first, consent last",
);

const row = buildClientOnboardingRow("11111111-1111-1111-1111-111111111111");
assert.equal(row.slug, CLIENT_ONBOARDING_SLUG);
assert.equal(row.enabled, true);
// on_complete_stage is written to the lead verbatim with no validation anywhere
// downstream — a typo becomes a phantom kanban column.
assert.ok(
  OASIS_LEAD_STAGE_KEYS.includes(row.on_complete_stage),
  `on_complete_stage "${row.on_complete_stage}" must be a real OASIS stage`,
);
assert.throws(
  () => buildClientOnboardingRow(""),
  /tenantId is required/,
  "no default tenant id — a wrong one would seed a client form into another tenant",
);

// form_submissions.payload is a FLAT map keyed by field name. Two fields
// sharing a name means one silently overwrites the other, across steps.
const allFieldNames = steps.flatMap((s) => s.fields.map((f) => f.name));
assert.equal(
  new Set(allFieldNames).size,
  allFieldNames.length,
  "field names are unique form-wide",
);

// The lead-token route prefills only a fixed whitelist. These four names are
// chosen to hit it; renaming them silently costs the client the prefill.
for (const prefilled of ["email", "phone", "business_name", "industry"]) {
  assert.ok(allFieldNames.includes(prefilled), `${prefilled} is named for lead-token prefill`);
}

// THE CONSTRAINT THE OPERATOR SET: never ask a client for a credential. OASIS
// owns the sending identity; the client supplies an address to be CC'd.
const CREDENTIAL_WORDS =
  /\b(password|passwd|app password|smtp|imap|api[ _-]?key|secret|credential|login|username|oauth|2fa)\b/i;
for (const step of steps) {
  for (const field of step.fields) {
    const surface = `${field.name} ${field.label} ${field.placeholder ?? ""}`;
    assert.ok(
      !CREDENTIAL_WORDS.test(surface),
      `field "${field.name}" must not ask for a credential — OASIS supplies the infrastructure`,
    );
  }
}

// Consent evidence is only worth something if it reproduces the wording the
// client actually saw. The label and the stored disclosure are ONE string.
const approvalStep = steps[4];
const consentField = approvalStep.fields.find((f) => f.name === "send_consent");
assert.ok(consentField, "approval step has the consent field");
assert.equal(
  consentField!.label,
  CLIENT_ONBOARDING_CONSENT_TEXT,
  "the consent label IS the stored disclosure text",
);
assert.equal(consentField!.required, true, "consent cannot be skipped");
assert.deepEqual(
  consentField!.options,
  [{ value: "agreed", label: "Yes, I authorize this" }],
  "single-option attestation, the house pattern",
);
// Wording that would make the record useless if it drifted.
for (const phrase of ["OASIS", "on my behalf", "copy the email address"]) {
  assert.ok(
    CLIENT_ONBOARDING_CONSENT_TEXT.includes(phrase),
    `consent text states "${phrase}"`,
  );
}

// ---------------------------------------------------------------------------
// Domain normalization — the webhook match key
// ---------------------------------------------------------------------------

assert.equal(normalizeWebsiteDomain("acme.com"), "acme.com");
assert.equal(normalizeWebsiteDomain("  ACME.com  "), "acme.com");
assert.equal(normalizeWebsiteDomain("https://acme.com"), "acme.com");
assert.equal(normalizeWebsiteDomain("http://www.acme.com/"), "acme.com");
assert.equal(normalizeWebsiteDomain("https://www.Acme-Heating.com/contact?utm=x"), "acme-heating.com");
assert.equal(normalizeWebsiteDomain("acme.com:8443"), "acme.com");
assert.equal(normalizeWebsiteDomain("acme.com."), "acme.com");
assert.equal(normalizeWebsiteDomain("shop.acme.co.uk"), "shop.acme.co.uk");
// Not usable — better to refuse than to store a row that can never match.
assert.equal(normalizeWebsiteDomain("acme"), null, "no TLD");
assert.equal(normalizeWebsiteDomain(""), null);
assert.equal(normalizeWebsiteDomain("   "), null);
assert.equal(normalizeWebsiteDomain(null), null);
assert.equal(normalizeWebsiteDomain("not a domain"), null);
assert.equal(normalizeWebsiteDomain("acme.c"), null, "one-letter TLD");
assert.equal(normalizeWebsiteDomain("-acme.com"), null, "leading hyphen");

// Whatever normalization emits must satisfy the table's CHECK constraints, or
// a row that passes here dies at the insert.
for (const input of ["https://WWW.Acme.com/x", "acme.com:8443", " acme.com. "]) {
  const d = normalizeWebsiteDomain(input)!;
  assert.equal(d, d.toLowerCase());
  assert.ok(!d.includes("://") && !d.includes("/") && !d.includes(" "));
  assert.ok(!d.endsWith(".") && d.includes("."));
}

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

assert.deepEqual(normalizeEmailAddress("  Owner@Acme.COM "), { email: "owner@acme.com" });
assert.deepEqual(normalizeEmailAddress("first.last+tag@acme.co.uk"), {
  email: "first.last+tag@acme.co.uk",
});
assert.ok("reason" in normalizeEmailAddress(""), "empty rejected");
assert.ok("reason" in normalizeEmailAddress("owner@"), "no domain rejected");
assert.ok("reason" in normalizeEmailAddress("@acme.com"), "no local part rejected");
assert.ok("reason" in normalizeEmailAddress("owner acme.com"), "no @ rejected");
assert.ok("reason" in normalizeEmailAddress("owner@acme"), "no TLD rejected");
assert.ok("reason" in normalizeEmailAddress(".owner@acme.com"), "leading dot rejected");
// The typo that would silently orphan a client from their own automation.
const typo = normalizeEmailAddress("owner@gmail.con");
assert.ok("reason" in typo && typo.reason.includes("owner@gmail.com"), "typo names the correction");

// A rejected CC address is REPORTED, never dropped: a client who thinks they
// are copied and is not is the failure this table exists to prevent.
const list = parseEmailList("Owner@Acme.com\nowner@acme.com\n\noffice@acme.com\nbroken@\n");
assert.deepEqual(list.emails, ["owner@acme.com", "office@acme.com"], "lowercased + deduped");
assert.equal(list.rejected.length, 1, "the bad one is reported, not silently discarded");
assert.deepEqual(parseEmailList("a@b.com, c@d.com; e@f.com").emails, [
  "a@b.com",
  "c@d.com",
  "e@f.com",
]);
assert.deepEqual(parseEmailList(""), { emails: [], rejected: [] });
assert.deepEqual(parseEmailList(undefined), { emails: [], rejected: [] });
assert.deepEqual(parseEmailList(["x@y.com", "  "]).emails, ["x@y.com"]);

// ---------------------------------------------------------------------------
// Free-text lists + the never-say escape hatch
// ---------------------------------------------------------------------------

assert.deepEqual(parseTextList("Furnace install\n\nAC repair\n- Maintenance"), [
  "Furnace install",
  "AC repair",
  "Maintenance",
]);
assert.deepEqual(parseTextList("Same\nsame"), ["Same"], "case-insensitive dedupe");
// "nothing" is how an honest owner answers a required question with no answer.
// Storing it literally would put "never say nothing" into the agent's prompt.
for (const none of ["nothing", "Nothing.", "N/A", "none"]) {
  assert.deepEqual(parseTextList(none, { allowExplicitNone: true }), [], `"${none}" → no rules`);
}
assert.deepEqual(parseTextList("nothing"), ["nothing"], "no escape hatch unless asked for");
assert.equal(parseTextList(Array.from({ length: 40 }, (_, i) => `s${i}`).join("\n")).length, 25);
// An array arrives if one of these fields is ever changed to a multiselect.
assert.deepEqual(parseTextList(["AC repair", "Furnace install"]), ["AC repair", "Furnace install"]);
assert.deepEqual(parseTextList([]), []);
assert.deepEqual(parseTextList(undefined), []);

// ---------------------------------------------------------------------------
// Ingest key
// ---------------------------------------------------------------------------

const k1 = mintIngestKey();
const k2 = mintIngestKey();
assert.notEqual(k1.raw, k2.raw, "keys are unique");
assert.notEqual(k1.raw, k1.hash, "the stored value is not the key");
assert.equal(k1.hash, hashIngestKey(k1.raw), "hash is reproducible for lookup");
assert.match(k1.hash, /^[0-9a-f]{64}$/, "matches the column's CHECK constraint");
assert.ok(k1.raw.startsWith("oasis_ing_"), "recognisable prefix for whoever pastes it");
assert.ok(k1.raw.length >= 40, "32 bytes of entropy, base64url");

// ---------------------------------------------------------------------------
// Intake → draft
// ---------------------------------------------------------------------------

const GOOD_INTAKE: Record<string, unknown> = {
  email: "Owner@AcmeHeating.com",
  cc_emails_additional: "office@acmeheating.com\nowner@acmeheating.com",
  notification_email: "",
  phone: "+15145550147",
  business_name: "Acme Heating & Cooling",
  what_you_do: "We install and repair residential furnaces and AC units.",
  industry: "HVAC / Heating & Cooling",
  service_area: "Montreal + West Island",
  business_hours: "Mon-Fri 8am-6pm\nSat 9am-1pm",
  timezone: "America/Toronto",
  top_services: "Furnace installation\nAC repair\nMaintenance plans",
  reply_tone: "friendly",
  brand_voice: "We always say the estimate is free.",
  never_say: "Never quote a price\nNever promise same-day service",
  response_speed: "15",
  website_domain: "https://www.AcmeHeating.com/",
  approver_name: "Dana Reyes",
  approver_email: "dana@acmeheating.com",
  send_consent: "agreed",
  consent_signed_name: "Dana Reyes",
};

const draft = buildClientProfileDraft(GOOD_INTAKE, {
  tenantId: "22222222-2222-2222-2222-222222222222",
  replyFromIdentity: "support@oasisai.work",
  consentAt: "2026-08-19T15:04:05.000Z",
});
assert.equal(draft.website_domain, "acmeheating.com", "domain normalized to the webhook's key");
assert.deepEqual(
  draft.cc_emails,
  ["owner@acmeheating.com", "office@acmeheating.com"],
  "primary first, deduped across both fields, lowercased",
);
assert.deepEqual(
  draft.notification_emails,
  draft.cc_emails,
  "blank notification address falls back to the CC list, never to nobody",
);
assert.equal(draft.reply_tone, "friendly");
assert.equal(draft.response_sla_minutes, 15);
assert.deepEqual(draft.services, ["Furnace installation", "AC repair", "Maintenance plans"]);
assert.equal(draft.prohibited_claims.length, 2);
assert.equal(draft.status, "pending", "provisioning never activates — a human decides that");
assert.equal(draft.send_consent_at, "2026-08-19T15:04:05.000Z");
assert.equal(draft.send_consent_name, "Dana Reyes");
assert.equal(
  (draft.send_consent_evidence as Record<string, unknown>).disclosure_text,
  CLIENT_ONBOARDING_CONSENT_TEXT,
  "the evidence carries the exact wording the client agreed to",
);
assert.deepEqual(draft.business_hours, {
  raw: "Mon-Fri 8am-6pm\nSat 9am-1pm",
  source: "client_onboarding_form",
});

// Unknown tone falls back but still complains, rather than silently changing
// how the agent speaks for a real business.
assert.throws(
  () => buildClientProfileDraft({ ...GOOD_INTAKE, reply_tone: "sassy" }, {
    tenantId: "t",
    replyFromIdentity: "support@oasisai.work",
  }),
  /reply_tone "sassy"/,
);

// No guessed default for who speaks as the client's business.
assert.throws(
  () => buildClientProfileDraft(GOOD_INTAKE, { tenantId: "t", replyFromIdentity: "" }),
  /replyFromIdentity is required/,
);

// EVERY problem at once, not the first one. An operator fixing an intake should
// see all four bad answers in one pass.
try {
  buildClientProfileDraft(
    {
      ...GOOD_INTAKE,
      email: "owner@gmail.con",
      cc_emails_additional: "",
      website_domain: "acme",
      business_name: "  ",
      approver_email: "dana@",
    },
    { tenantId: "t", replyFromIdentity: "support@oasisai.work" },
  );
  assert.fail("expected ProfileDraftError");
} catch (err) {
  assert.ok(err instanceof ProfileDraftError, "typed error, not a bare Error");
  const joined = err.problems.join(" | ");
  assert.ok(joined.includes("business_name"), "reports the empty name");
  assert.ok(joined.includes("website_domain"), "reports the unusable domain");
  assert.ok(joined.includes("gmail.com"), "reports the CC typo with its correction");
  assert.ok(joined.includes("no usable CC address"), "reports that nobody would be copied");
  assert.ok(joined.includes("approver email"), "reports the bad approver address");
  assert.ok(err.problems.length >= 5, `all problems at once, got ${err.problems.length}`);
  // The raw key must never appear in an error surfaced to an operator log.
  assert.ok(!/oasis_ing_/.test(err.message), "no secret material in the error");
}

// A client who declines is not silently treated as consenting.
assert.throws(
  () => buildClientProfileDraft({ ...GOOD_INTAKE, send_consent: "no" }, {
    tenantId: "t",
    replyFromIdentity: "support@oasisai.work",
  }),
  /no authority to send/,
);

// Consent absent entirely: provisioning is allowed (status pending), but the
// row carries no consent, and the table's CHECK blocks activation.
const noConsent = buildClientProfileDraft(
  { ...GOOD_INTAKE, send_consent: "", consent_signed_name: "" },
  { tenantId: "t", replyFromIdentity: "support@oasisai.work" },
);
assert.equal(noConsent.send_consent_at, null);
assert.deepEqual(noConsent.send_consent_evidence, {});
assert.equal(noConsent.status, "pending");

// ---------------------------------------------------------------------------
// Lifecycle guards that refuse before they reach the database
// ---------------------------------------------------------------------------
// This repo's tsx transform targets CJS, so top-level await is unavailable.
async function main(): Promise<void> {
  // An unexplained pause becomes a profile nobody dares turn back on. The guard
  // must fire before any query, so this is safe with no database configured.
  for (const reason of ["", "   "]) {
    await assert.rejects(
      () => pauseClientAutomationProfile({ id: "x", tenantId: "t", reason }),
      (err: unknown) =>
        err instanceof ProfileDraftError && /pause needs a reason/.test((err as Error).message),
      `pause with reason "${reason}" is refused before touching the database`,
    );
  }
}

main().then(() => console.log("client-automation-profiles ok"));
