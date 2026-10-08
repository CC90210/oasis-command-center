import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_AUDIT_STEPS } from "../lib/forms/oasis-ai-audit-seed";

// The homepage audit form (components/marketing/AuditForm.tsx) POSTs step 0
// of the ai-audit funnel inline. On 2026-08-20 the seed made phone required on
// that step; the form never sent it, so app/api/forms/submit answered every
// inline submit with 400 missing_required_field — after the lead row was
// already written, so nobody was alerted — until 2026-10-08. This test pins
// the form's fields to the seed's step 0 so the two cannot drift apart again.

const root = join(__dirname, "..");
const source = readFileSync(join(root, "components/marketing/AuditForm.tsx"), "utf8");
const step0 = AI_AUDIT_STEPS[0];
const declared = new Map(step0.fields.map((f) => [f.name, Boolean(f.required)]));

// What the submit sends: `key: String(form.get("key") ...)` inside `const payload`.
const payloadBlock = source.match(/const payload = \{([\s\S]*?)\};/);
assert.ok(payloadBlock, "AuditForm must build its POST body in `const payload = { ... }`");
const posted = [...payloadBlock[1].matchAll(/(\w+):\s*String\(form\.get\("(\w+)"\)/g)].map(([, key, input]) => {
  assert.equal(key, input, `payload key ${key} must read the input of the same name`);
  return key;
});

// What the visitor sees: every <Field name="..." [required] />.
const rendered = new Map(
  [...source.matchAll(/<Field\b([\s\S]*?)\/>/g)].map(([, attrs]) => {
    const name = attrs.match(/name="(\w+)"/)?.[1];
    assert.ok(name, `a <Field> has no name: ${attrs.trim()}`);
    return [name, /\brequired\b/.test(attrs)];
  }),
);

for (const [name, required] of declared) {
  if (!required) continue;
  assert.ok(posted.includes(name), `step 0 requires "${name}" but AuditForm does not send it`);
  assert.equal(rendered.get(name), true, `step 0 requires "${name}" but AuditForm does not show it as required`);
}
for (const name of posted) {
  assert.ok(declared.has(name), `AuditForm sends "${name}", which step 0 does not declare`);
}
for (const name of rendered.keys()) {
  assert.ok(posted.includes(name), `AuditForm shows "${name}" but never sends it`);
  if (!declared.get(name)) {
    assert.equal(rendered.get(name), false, `"${name}" is optional in step 0 but required on the homepage form`);
  }
}

console.log("audit form fields: passed");
