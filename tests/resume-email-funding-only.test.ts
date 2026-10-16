/**
 * The "pick up where you left off" email is a funding application's, and only
 * a funding workspace queues it (2026-10-16, Bravo's end-to-end test of the
 * OASIS AI audit: step 1 queued "Finish your application ... bank statements,
 * ID, voided check" for an OASIS lead who booked a minute later).
 *
 * Run: node --conditions=react-server --import tsx tests/resume-email-funding-only.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("app/api/forms/submit/route.ts", "utf8");

const calls = route.match(/maybeQueueResumeEmail\(\{/g) || [];
assert.equal(calls.length, 1, "one place queues the resume email");
const at = route.indexOf("await maybeQueueResumeEmail({");
const guard = route.lastIndexOf("} else if (", at);
assert.ok(guard > 0, "the resume email is queued outside any branch");
assert.match(
  route.slice(guard, at),
  /^\} else if \(!isLastStep && isFundingTenant\(link\.tenant\)\) \{/,
  "the resume email is queued for a workspace that is not a funding one",
);
// The funding check itself: the SunBiz slugs, nothing broader.
assert.match(route, /function isFundingTenant\(tenantSlug: string\): boolean \{\s*const s = \(tenantSlug \|\| ""\)\.toLowerCase\(\);\s*return s === "sun" \|\| s === "submissions";\s*\}/);
// The copy it would send is a funding application's: proof the gate is the right one.
assert.match(readFileSync("lib/forms/resume-link.ts", "utf8"), /bank statements, ID, voided check/);

console.log("resume-email-funding-only: ok");
