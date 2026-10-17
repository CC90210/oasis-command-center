import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_AUDIT_SLUG, AI_AUDIT_STEPS, AI_AUDIT_TENANT_SLUG } from "../lib/forms/oasis-ai-audit-seed";
import {
  AUDIT_ATTRIBUTION_FIELDS,
  AUDIT_CONSENT_FIELDS,
  AUDIT_FORM_FIELDS,
  AUDIT_FORM_HANDOFF,
  AUDIT_FORM_REQUIRED,
  auditAttributionFromSearch,
  auditFormBody,
  auditFormContinuationPath,
  auditFormProblem,
} from "../components/marketing/audit-form-body";

// The homepage audit form (components/marketing/AuditForm.tsx) POSTs step 0
// of the ai-audit funnel inline. On 2026-08-20 the seed made phone required on
// that step; the form never sent it, so app/api/forms/submit answered every
// inline submit with 400 missing_required_field — after the lead row was
// already written, so nobody was alerted — until 2026-10-08. This test pins
// what the form SENDS to the seed's step 0, so the two cannot drift apart again.

const root = join(__dirname, "..");
const step0 = AI_AUDIT_STEPS[0];

// 1. The form's field lists are step 0's, complete and in order — optional ones too.
assert.deepEqual([...AUDIT_FORM_FIELDS], step0.fields.map((f) => f.name), "AUDIT_FORM_FIELDS must be every field step 0 declares, in order");
assert.deepEqual(
  [...AUDIT_FORM_REQUIRED],
  step0.fields.filter((f) => f.required).map((f) => f.name),
  "AUDIT_FORM_REQUIRED must be exactly the fields step 0 requires",
);

// 2. What is sent: real FormData in, the exact request body out.
const typed = {
  name: " Ada Lovelace ",
  email: "ada@example.com",
  phone: " +1 514 555 0123 ",
  company: "Acme HVAC",
  website: " acme.com ",
};
const form = new FormData();
for (const [key, value] of Object.entries(typed)) form.set(key, value);
form.set(AUDIT_CONSENT_FIELDS.email, "true");
const context = {
  submissionPath: "/contact",
  visitId: "visit-123",
  attribution: {
    utm_source: "google",
    utm_medium: "paid-search",
    utm_campaign: "fleet-launch",
    kw: "ai agents",
    cat: "p2",
  },
};
assert.deepEqual(auditFormBody(form, context), {
  step_index: 0,
  anonymous_init: { tenant_slug: AI_AUDIT_TENANT_SLUG, form_slug: AI_AUDIT_SLUG },
  payload: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 514 555 0123",
    company: "Acme HVAC",
    website: "acme.com",
  },
  consent_ledger: { email: true, sms: false },
  submission_path: "/contact",
  visit_id: "visit-123",
  ...context.attribution,
});
const blankWebsite = new FormData();
for (const [key, value] of Object.entries({ ...typed, website: "" })) blankWebsite.set(key, value);
assert.equal(auditFormBody(blankWebsite, context).payload.website, "", "an empty optional field is still sent, as empty");

// 2b. Consent and attribution are first-class submit data, not UI-only copy.
assert.deepEqual(
  [...AUDIT_ATTRIBUTION_FIELDS],
  ["utm_source", "utm_medium", "utm_campaign", "kw", "cat"],
  "the inline form forwards the same attribution vocabulary as FormPublicClient",
);
assert.deepEqual(
  auditAttributionFromSearch("?utm_source=%20partner%20&utm_medium=email&utm_campaign=october&kw=agents&cat=p3&ignored=no"),
  { utm_source: "partner", utm_medium: "email", utm_campaign: "october", kw: "agents", cat: "p3" },
);
assert.deepEqual(
  auditFormBody(blankWebsite, { submissionPath: "//evil.example", visitId: null, attribution: {} }),
  {
    step_index: 0,
    anonymous_init: { tenant_slug: AI_AUDIT_TENANT_SLUG, form_slug: AI_AUDIT_SLUG },
    payload: {
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+1 514 555 0123",
      company: "Acme HVAC",
      website: "",
    },
    consent_ledger: { email: false, sms: false },
    submission_path: `/f/${AI_AUDIT_TENANT_SLUG}/${AI_AUDIT_SLUG}`,
  },
  "an unsafe source path falls back to the canonical funnel and a missing visit id is not invented",
);
assert.equal(
  auditFormContinuationPath(`/f/${AI_AUDIT_TENANT_SLUG}/${AI_AUDIT_SLUG}/signed-token`, context),
  "/f/oasis-ai-cc/ai-audit/signed-token?utm_source=google&utm_medium=paid-search&utm_campaign=fleet-launch&kw=ai+agents&cat=p2&v=visit-123&handoff=homepage-audit-step-0&step=1",
  "the personalized continuation keeps campaign/visit attribution and a non-PII step handoff, but no contact fields",
);
assert.deepEqual(
  AUDIT_FORM_HANDOFF,
  { markerParam: "handoff", markerValue: "homepage-audit-step-0", stepParam: "step", nextStep: 1 },
  "the handoff marker and destination step stay explicit and non-PII",
);

// 3. The component sends exactly that body and builds no other.
const source = readFileSync(join(root, "components/marketing/AuditForm.tsx"), "utf8");
assert.match(source, /const body = auditFormBody\(new FormData\(e\.currentTarget\), context\);/, "AuditForm must build its body with auditFormBody");
assert.match(source, /body: JSON\.stringify\(body\)/, "AuditForm must POST that body");
assert.equal((source.match(/JSON\.stringify\(/g) ?? []).length, 1, "AuditForm must build exactly one request body");
assert.doesNotMatch(source, /form\.get\(/, "AuditForm must not read fields outside auditFormBody");
assert.match(source, /auditAttributionFromSearch\(window\.location\.search\)/, "the current landing URL supplies attribution");
assert.match(source, /submissionPath: window\.location\.pathname/, "the exact public landing path is recorded");
assert.match(source, /visitId: getOrCreateVisitId\(\)/, "the established per-tab visit id is submitted");
assert.match(source, /auditFormContinuationPath\(nextPath, context\)/, "the same attribution context survives the personalized hop");

// 3a. The personalized page accepts the handoff only for the canonical OASIS
// ai-audit form, and the reusable form client clamps the requested index.
const tokenPageSource = readFileSync(join(root, "app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx"), "utf8");
assert.match(
  tokenPageSource,
  /result\.tenant_slug === AI_AUDIT_TENANT_SLUG\s*&&\s*result\.form\.slug === AI_AUDIT_SLUG/,
  "a handoff marker on another tenant or form must not skip its first step",
);
assert.match(
  tokenPageSource,
  /sp\[AUDIT_FORM_HANDOFF\.markerParam\] === AUDIT_FORM_HANDOFF\.markerValue[\s\S]*sp\[AUDIT_FORM_HANDOFF\.stepParam\] === String\(AUDIT_FORM_HANDOFF\.nextStep\)/,
  "both the exact marker and requested step are required",
);
assert.match(tokenPageSource, /initialStep=\{initialStep\}/, "the validated step reaches the form client");
const publicClientSource = readFileSync(join(root, "components/forms/FormPublicClient.tsx"), "utf8");
assert.match(publicClientSource, /if \(!Number\.isInteger\(initialStep\)\) return 0;/, "missing or fractional initial steps fall back to step 0");
assert.match(
  publicClientSource,
  /Math\.min\(Math\.max\(initialStep \?\? 0, 0\), Math\.max\(steps\.length - 1, 0\)\)/,
  "the initial step is clamped to the live form definition",
);

// 3b. No JavaScript may degrade into the browser's default GET, which would
// put name/email/phone in the address bar and server logs.
assert.match(source, /action="\/api\/forms\/submit"/, "the progressive fallback points at the submit endpoint");
assert.match(source, /method="post"/, "the progressive fallback never serializes PII into a query string");
assert.match(source, /<noscript>/, "visitors without JavaScript receive an actionable explanation");

// 3c. Both optional channels are separate, controlled and initially false,
// and their words come from the same canonical function the server hashes.
assert.match(source, /email: false,\s*sms: false,/, "both consent choices start unticked");
assert.match(source, /\(\["email", "sms"\] as const\)\.map/, "email and SMS render as separate controls");
assert.match(source, /name=\{AUDIT_CONSENT_FIELDS\[channel\]\}/, "each control is present in FormData");
// Since 2026-10-16 the box shows a summary line with the canonical text under
// "Full terms": ConsentChoice renders consentDisclosureText for this channel and
// identity (tests/consent-summary.test.ts proves the text is in the markup).
assert.match(
  source,
  /<ConsentChoice[\s\S]{0,300}channel=\{channel\}[\s\S]{0,60}identity=\{consentIdentity\}/,
  "the UI renders canonical disclosure text through ConsentChoice",
);

const homeSource = readFileSync(join(root, "app/(marketing)/home/page.tsx"), "utf8");
const contactSource = readFileSync(join(root, "app/(marketing)/contact/page.tsx"), "utf8");
for (const [name, pageSource] of [["home", homeSource], ["contact", contactSource]] as const) {
  assert.match(pageSource, /resolveConsentIdentity\(\{ tenantSlug: AUDIT_FUNNEL\.tenantSlug \}\)\.identity/, `${name} resolves the OASIS ledger identity server-side`);
  assert.match(pageSource, /<AuditForm consentIdentity=\{consentIdentity\} \/>/, `${name} passes that exact identity to the client form`);
}

// 4. What the visitor sees: one <Field> per declared field, required where step 0 requires it.
const rendered = new Map(
  [...source.matchAll(/<Field\b([\s\S]*?)\/>/g)].map(([, attrs]) => {
    const name = attrs.match(/name="(\w+)"/)?.[1];
    assert.ok(name, `a <Field> has no name: ${attrs.trim()}`);
    return [name, /\brequired\b/.test(attrs)];
  }),
);
assert.deepEqual([...rendered.keys()], [...AUDIT_FORM_FIELDS], "AuditForm must show every step 0 field, in order");
for (const [name, required] of rendered) {
  assert.equal(required, (AUDIT_FORM_REQUIRED as readonly string[]).includes(name), `"${name}" must be required exactly when step 0 requires it`);
}

// 5. Checked before anything is sent: the route writes the lead before it validates.
const ok = { name: "Ada", email: "ada@example.com", phone: "+91 98765 43210", company: "Acme", website: "" };
assert.equal(auditFormProblem(ok), null, "an international number with its country code is accepted");
assert.equal(auditFormProblem({ ...ok, phone: "(514) 555-0123" }), null, "a North American number is accepted");
assert.equal(auditFormProblem({ ...ok, website: "" }), null, "website stays optional");
assert.match(auditFormProblem({ ...ok, phone: "call me" }) ?? "", /doesn't look right/, "a phone with no number in it is refused");
// The send gate's own rule (normalizeConsentSubject): letters around digits are
// refused, never stripped into a number nobody typed.
assert.match(auditFormProblem({ ...ok, phone: "not-a-phone 5145550123" }) ?? "", /doesn't look right/);
assert.match(auditFormProblem({ ...ok, phone: "514 555 0123 ext 22" }) ?? "", /doesn't look right/);
assert.match(auditFormProblem({ ...ok, name: "", company: "" }) ?? "", /your name and your company/);
const spaces = new FormData();
for (const [key, value] of Object.entries({ ...typed, phone: "   " })) spaces.set(key, value);
assert.match(
  auditFormProblem(auditFormBody(spaces, context).payload) ?? "",
  /your mobile number/,
  "a phone of only spaces passes the browser's `required` but must not be sent",
);

// 6. Mobile controls meet the platform accessibility floor.
assert.match(source, /text-\[16px\][^"\n]*sm:text-\[15px\]/, "mobile text inputs stay at 16px to prevent iOS focus zoom");
const navSource = readFileSync(join(root, "components/marketing/MarketingNav.tsx"), "utf8");
assert.match(navSource, /className="-mr-2 flex h-11 w-11 items-center justify-center[^\"]*lg:hidden"/, "the mobile menu has a 44 by 44 CSS-pixel target");

console.log("audit form fields: passed");
