import assert from "node:assert/strict";
import {
  validateCustomMessage,
  renderCustomMessage,
  unknownMergeFields,
  MAX_SUBJECT,
  MAX_BODY,
  MIN_BODY,
} from "../lib/bulk-email/compose";
import {
  classifyBulkRecipients,
  summarizeClassification,
  redactForResponse,
  type BulkRecord,
} from "../lib/bulk-email/recipients";

// Operator-authored bulk email ("write your own") + the eligibility preflight.
// Both are PURE so the composer's preview and the server's queue write run the
// SAME code — the number an operator approves is the number that sends.

// ---------------------------------------------------------------------------
// validateCustomMessage
// ---------------------------------------------------------------------------
const okMsg = { subject: "Quick question about {{business_name}}", body: "Hi {{first_name}}, do you have two minutes to talk numbers this week?" };
const good = validateCustomMessage(okMsg);
assert.equal(good.ok, true, "a clean message validates");
assert.equal(good.ok && good.value.subject, "Quick question about {{business_name}}");

assert.equal(validateCustomMessage({ subject: "", body: okMsg.body }).ok, false, "subject required");
assert.equal(
  (validateCustomMessage({ subject: "  ", body: okMsg.body }) as { problem: string }).problem,
  "subject_required",
  "whitespace-only subject is empty",
);
assert.equal(
  (validateCustomMessage({ subject: "hi", body: "" }) as { problem: string }).problem,
  "body_required",
  "body required",
);
assert.equal(
  (validateCustomMessage({ subject: "hi", body: "too short" }) as { problem: string }).problem,
  "body_too_short",
  `a body under ${MIN_BODY} chars is an accident, not a message`,
);
assert.equal(
  (validateCustomMessage({ subject: "x".repeat(MAX_SUBJECT + 1), body: okMsg.body }) as { problem: string }).problem,
  "subject_too_long",
);
assert.equal(
  (validateCustomMessage({ subject: "hi", body: "x".repeat(MAX_BODY + 1) }) as { problem: string }).problem,
  "body_too_long",
);

// Non-string input must not throw — the route hands us raw JSON.
assert.equal(validateCustomMessage({ subject: 42, body: null }).ok, false, "non-string input is invalid, not a crash");

// --- unknown merge fields are the load-bearing case -------------------------
// A typo'd token would otherwise be DELIVERED LITERALLY to a real merchant.
assert.deepEqual(unknownMergeFields("Hi {{name}}, about {{business_name}}"), ["{{name}}"], "flags only the unknown token");
assert.deepEqual(unknownMergeFields("Hi {{first_name}}"), [], "known token is clean");
const typo = validateCustomMessage({ subject: "Hi {{name}}", body: okMsg.body });
assert.equal(typo.ok, false, "a typo'd merge field blocks the send");
assert.equal((typo as { problem: string }).problem, "unknown_merge_field");
assert.deepEqual((typo as { tokens: string[] }).tokens, ["{{name}}"], "names the offending token");
assert.match(
  (typo as { message: string }).message,
  /send exactly like that/,
  "explains the consequence in plain language, not a code",
);

// Casing + inner whitespace must not decide whether a merchant sees their name.
const loose = validateCustomMessage({ subject: "Hi {{ First_Name }}", body: okMsg.body });
assert.equal(loose.ok, true, "{{ First_Name }} is the same field as {{first_name}}");
assert.equal(loose.ok && loose.value.subject, "Hi {{first_name}}", "canonicalized on the way in");

// ---------------------------------------------------------------------------
// renderCustomMessage
// ---------------------------------------------------------------------------
const rendered = renderCustomMessage(okMsg, { firstName: "Dave Klein", businessName: "Klein Auto" });
assert.equal(rendered.subject, "Quick question about Klein Auto");
assert.equal(rendered.body, "Hi Dave, do you have two minutes to talk numbers this week?", "first name only");

// A thin lead must never receive "Hi ," — that is what makes a batch read as spam.
const thin = renderCustomMessage(okMsg, { firstName: "", businessName: null });
assert.equal(thin.body, "Hi there, do you have two minutes to talk numbers this week?");
assert.equal(thin.subject, "Quick question about your business");

// Every occurrence, not just the first.
assert.equal(
  renderCustomMessage({ subject: "s", body: "{{first_name}} and {{first_name}}" }, { firstName: "Ann" }).body,
  "Ann and Ann",
  "replaces every occurrence",
);

// Rendering accepts the loose form too, so a preview can never disagree.
assert.equal(
  renderCustomMessage({ subject: "s", body: "Hi {{ FIRST_NAME }}" }, { firstName: "Ann" }).body,
  "Hi Ann",
);

// ---------------------------------------------------------------------------
// classifyBulkRecipients — the preflight
// ---------------------------------------------------------------------------
const rec = (id: string, data: Record<string, unknown>): [string, BulkRecord] => [id, { id, data }];
const all = new Map<string, BulkRecord>([
  rec("a", { email: "a@x.com", contact_name: "Ann Lee", business_name: "Ann LLC" }),
  rec("b", { phone: "5551234567" }), // phone-only: the SunBiz default
  rec("c", { email: "not-an-email" }),
  rec("d", { contact_email: "d@x.com", name: "Dee" }),
  rec("e", { email: "e@x.com", assigned_to: "someone-else" }),
]);
const yes = () => true;

const c = classifyBulkRecipients(["a", "b", "c", "d", "zz"], all, yes);
assert.equal(c.counts.selected, 5);
assert.equal(c.counts.eligible, 2, "a + d are emailable");
assert.equal(c.counts.no_email, 2, "phone-only and malformed both count as no_email");
assert.equal(c.counts.not_found, 1, "zz isn't in the tenant");
assert.deepEqual(c.eligible.map((r) => r.id), ["a", "d"], "selection order preserved");
assert.equal(c.eligible[0].firstName, "Ann Lee", "raw name; the renderer takes the first word");
assert.equal(c.eligible[1].toEmail, "d@x.com", "falls back to contact_email");
assert.equal(c.eligible[1].businessName, "Dee", "falls back to name when no business_name");

// A record the viewer can't act on is reported as no_access, never merged into
// no_email — the operator needs to know it's a permissions problem, not data.
const scoped = classifyBulkRecipients(["a", "e"], all, (d) => d.assigned_to !== "someone-else");
assert.equal(scoped.counts.no_access, 1);
assert.equal(scoped.counts.eligible, 1);
assert.deepEqual(scoped.skipped, [{ id: "e", reason: "no_access" }]);

// Empty selection must not throw.
assert.equal(classifyBulkRecipients([], all, yes).counts.selected, 0);

// --- redactForResponse: no UUID oracle -------------------------------------
// "exists but not yours" must be indistinguishable from "does not exist", or a
// non-admin can submit arbitrary UUIDs and read off which are real.
const oracle = classifyBulkRecipients(["e", "zz"], all, (d) => d.assigned_to !== "someone-else");
assert.equal(oracle.counts.no_access, 1, "internally the distinction is real");
assert.equal(oracle.counts.not_found, 1);
const safe = redactForResponse(oracle);
assert.equal(safe.counts.no_access, 0, "and is erased on the way out");
assert.equal(safe.counts.not_found, 2, "both fold into one bucket");
assert.deepEqual(
  safe.skipped.map((s) => s.reason),
  ["not_found", "not_found"],
  "per-id reasons are folded too, not just the counts",
);
assert.equal(
  new Set(safe.skipped.map((s) => s.reason)).size,
  1,
  "a real record and a fake one are reported identically",
);
// The eligible set is untouched: this hides a reason, never a recipient.
assert.deepEqual(redactForResponse(c).eligible, c.eligible);
// No-op when there is nothing to hide (admins never produce no_access).
assert.equal(redactForResponse(c), c, "returns the same object when no_access is 0");
// The shared label must be true of BOTH cases it now covers, and must not
// leak which one applies. Uses a selection with a sendable record so the
// summary reaches the per-reason labels rather than the all-blocked sentence.
const mixed = redactForResponse(
  classifyBulkRecipients(["a", "e", "zz"], all, (d) => d.assigned_to !== "someone-else"),
);
const mixedLine = summarizeClassification(mixed);
assert.equal(mixedLine, "3 leads selected · 1 can be emailed · 2 not available to you");
assert.ok(
  !/assigned|someone else|access|permission/i.test(mixedLine),
  "wording must not hint that the record exists but belongs to someone else",
);

// ---------------------------------------------------------------------------
// summarizeClassification — the sentence the operator reads before confirming
// ---------------------------------------------------------------------------
assert.equal(
  summarizeClassification(classifyBulkRecipients(["a", "b", "c", "d", "zz"], all, yes)),
  "5 leads selected · 2 can be emailed · 2 no email address on file · 1 not available to you",
);
assert.equal(
  summarizeClassification(classifyBulkRecipients(["a"], all, yes)),
  "1 lead selected · 1 can be emailed",
  "singular, and no noise when nothing was skipped",
);
assert.equal(
  summarizeClassification(classifyBulkRecipients(["b"], all, yes)),
  "None of the 1 lead you selected can be emailed.",
  "the all-skipped case is stated outright, not as '0 queued'",
);
assert.equal(summarizeClassification(classifyBulkRecipients([], all, yes)), "Nothing selected.");
assert.match(
  summarizeClassification(classifyBulkRecipients(["a", "b"], all, yes), "application"),
  /^2 applications selected/,
  "noun is caller-supplied",
);

// No em dashes in anything an operator or merchant reads.
for (const s of [
  summarizeClassification(classifyBulkRecipients(["a", "b", "c"], all, yes)),
  (typo as { message: string }).message,
]) {
  assert.ok(!/[—–]/.test(s), `no em/en dashes in operator copy: ${s}`);
}

console.log("ok bulk-email-compose");
