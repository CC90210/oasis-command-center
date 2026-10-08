import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_AUDIT_SLUG, AI_AUDIT_STEPS, AI_AUDIT_TENANT_SLUG } from "../lib/forms/oasis-ai-audit-seed";
import {
  AUDIT_FORM_FIELDS,
  AUDIT_FORM_REQUIRED,
  auditFormBody,
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
assert.deepEqual(auditFormBody(form), {
  step_index: 0,
  anonymous_init: { tenant_slug: AI_AUDIT_TENANT_SLUG, form_slug: AI_AUDIT_SLUG },
  payload: {
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+1 514 555 0123",
    company: "Acme HVAC",
    website: "acme.com",
  },
});
const blankWebsite = new FormData();
for (const [key, value] of Object.entries({ ...typed, website: "" })) blankWebsite.set(key, value);
assert.equal(auditFormBody(blankWebsite).payload.website, "", "an empty optional field is still sent, as empty");

// 3. The component sends exactly that body and builds no other.
const source = readFileSync(join(root, "components/marketing/AuditForm.tsx"), "utf8");
assert.match(source, /const body = auditFormBody\(new FormData\(e\.currentTarget\)\);/, "AuditForm must build its body with auditFormBody");
assert.match(source, /body: JSON\.stringify\(body\)/, "AuditForm must POST that body");
assert.equal((source.match(/JSON\.stringify\(/g) ?? []).length, 1, "AuditForm must build exactly one request body");
assert.doesNotMatch(source, /form\.get\(/, "AuditForm must not read fields outside auditFormBody");

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
assert.match(auditFormProblem({ ...ok, name: "", company: "" }) ?? "", /your name and your company/);
const spaces = new FormData();
for (const [key, value] of Object.entries({ ...typed, phone: "   " })) spaces.set(key, value);
assert.match(
  auditFormProblem(auditFormBody(spaces).payload) ?? "",
  /your mobile number/,
  "a phone of only spaces passes the browser's `required` but must not be sent",
);

console.log("audit form fields: passed");
