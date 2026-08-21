import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ROUTE = "app/api/web-leads/[id]/outcome/route.ts";
const LIB = "lib/web-leads/outcome.ts";
const UI = "components/web-leads/CallOutcomeLog.tsx";

const route = read(ROUTE);
const lib = read(LIB);
const ui = read(UI);

// ---------------------------------------------------------------------------
// Build C (2026-08-21 leads-to-pipeline-design.md, section 5): the outcome
// route is a NEW door onto the tenant_records table, so it must pass the
// identical auth gate the sibling web-leads routes already prove -- resolve
// the caller, branch on session.ok (not session's truthiness), fail closed
// on an unresolved caller, and refuse a caller from another tenant, BOTH
// before any read or write. Same convention as tests/web-leads-guards.test.ts's
// Task-3 block for the audit route.
// ---------------------------------------------------------------------------
assert.match(route, /resolveSessionContext/, `${ROUTE} must resolve the caller`);
assert.match(
  route,
  /if\s*\(\s*!\s*session\.ok\s*\)/,
  `${ROUTE} must branch on session.ok, not on session's truthiness`,
);
assert.match(route, /status:\s*401/, `${ROUTE} must fail closed on an unresolved caller`);
assert.match(
  route,
  /session\.tenantId/,
  `${ROUTE} must reference session.tenantId -- resolving it and never checking it is how the sibling routes leaked`,
);
assert.match(route, /status:\s*403/, `${ROUTE} must refuse a caller from another tenant with a 403`);

// A lead outside the viewer's scope must 404, never 403 -- the id must not
// be probeable. Both GET and POST share one `authorize()` helper, so this
// is asserted once against the shared function rather than duplicated per
// verb.
assert.match(route, /fetchLead\(/, `${ROUTE} must call fetchLead so agent-role scoping applies, not just the tenant pin`);
assert.match(route, /status:\s*404/, `${ROUTE} must answer 404, not 403, for a lead outside the viewer's scope`);

// A tenant check alone is not sufficient -- `agent` is the commission-only
// outside-contractor role that lives INSIDE the tenant (see
// isScopedContractor in lib/web-leads/data.ts). The route must actually wire
// the viewer's role/admin bits through to fetchLead, not just pin the tenant.
assert.match(route, /session\.teamRole/, `${ROUTE} must reference session.teamRole when building the viewer`);
assert.match(route, /session\.isAdmin/, `${ROUTE} must reference session.isAdmin when building the viewer`);

// ---------------------------------------------------------------------------
// APPEND-ONLY. No update or delete path anywhere in the route or the data
// layer -- a mis-click is corrected by logging a LATER outcome, not by
// editing history, so a rep's call history stays reconstructable.
// ---------------------------------------------------------------------------
assert.doesNotMatch(route, /export\s+async\s+function\s+PUT\b/, `${ROUTE} must not export PUT`);
assert.doesNotMatch(route, /export\s+async\s+function\s+PATCH\b/, `${ROUTE} must not export PATCH`);
assert.doesNotMatch(route, /export\s+async\s+function\s+DELETE\b/, `${ROUTE} must not export DELETE`);
assert.match(route, /export\s+async\s+function\s+GET\b/, `${ROUTE} must export GET (history readback)`);
assert.match(route, /export\s+async\s+function\s+POST\b/, `${ROUTE} must export POST (log an outcome)`);

// No .update( or .delete( against leadgen_call_outcomes anywhere in the data
// layer. updateRecord() IS called from this file, but only against
// tenant_records' `stage` field (asserted separately below) -- this check
// isolates the outcomes table specifically so that call is never mistaken
// for cover.
const libCode = stripComments(lib);
assert.doesNotMatch(
  libCode,
  /leadgen_call_outcomes["'][\s\S]{0,200}?\.(update|delete)\(/,
  `${LIB} must never update or delete a leadgen_call_outcomes row`,
);
assert.match(libCode, /\.from\("leadgen_call_outcomes"\)[\s\S]{0,80}?\.insert\(/, `${LIB} must insert into leadgen_call_outcomes (append-only write)`);

// ---------------------------------------------------------------------------
// THE CONSTRAINED PART. nextStage() must import CC's real stage constant
// rather than hardcoding stage strings, so a rename over there breaks this
// build instead of silently writing an invalid stage. And it must carry a
// prominent comment explaining the constraint is pending CC's answer, so a
// future editor cannot widen it without also deleting the reasoning that
// argues against that.
// ---------------------------------------------------------------------------
assert.match(
  lib,
  /import\s*\{\s*WEBSITE_SALES_STAGES/,
  `${LIB} must import WEBSITE_SALES_STAGES from CC's lib/website-sales.ts, not hardcode stage names`,
);
assert.match(lib, /@\/lib\/website-sales/, `${LIB} must import from lib/website-sales.ts`);
assert.match(
  lib,
  /THE CONSTRAINED PART/,
  `${LIB} must carry a prominent comment marking the stage-advance logic as constrained`,
);
assert.match(
  lib,
  /pending CC's answer|have not received a usable answer/,
  `${LIB} must document that the restriction is pending CC's answer on the supported way to advance a stage`,
);

// nextStage's return type/callers must never touch anything beyond
// connected/lost. Named explicitly, mirroring the exhaustive runtime check
// in tests/web-leads-outcome.test.ts with a static one over the source.
for (const forbidden of ["qualified", "founder_meeting_booked", "proposal_sent", "won", "onboarding"]) {
  assert.doesNotMatch(
    libCode,
    new RegExp(`return\\s+"${forbidden}"`),
    `${LIB} must never return "${forbidden}" from nextStage`,
  );
}

// ---------------------------------------------------------------------------
// The ONLY tenant_records write in this feature is `data.stage` -- no
// pricing, commission, or other lifecycle field. Isolates the actual
// updateRecord() call's patch object rather than merely checking the word
// "stage" appears somewhere in the file.
// ---------------------------------------------------------------------------
const updateCall = libCode.match(/updateRecord\(\{[\s\S]{0,400}?\}\);/);
assert.ok(updateCall, `${LIB} must call updateRecord() to advance the stage`);
assert.match(updateCall![0], /patch:\s*\{\s*stage:\s*target\s*\}/, `${LIB}'s updateRecord() call must patch ONLY { stage: target }`);
for (const forbiddenField of ["price", "commission", "setupAmount", "monthlyAmount", "collectedSetupAmount", "assigned_to"]) {
  assert.doesNotMatch(
    updateCall![0],
    new RegExp(forbiddenField, "i"),
    `${LIB}'s updateRecord() patch must never touch "${forbiddenField}"`,
  );
}

// ---------------------------------------------------------------------------
// Tenant scoping on the write itself -- libSQL has no row-level security, so
// the insert must pin WEBDEV_TENANT_ID explicitly, the same convention every
// other write and read in this feature follows.
// ---------------------------------------------------------------------------
assert.match(libCode, /tenant_id:\s*WEBDEV_TENANT_ID/, `${LIB} must pin WEBDEV_TENANT_ID on the leadgen_call_outcomes insert`);

// ---------------------------------------------------------------------------
// No colour keyed to sentiment on the four buttons. "Not interested" is
// information a rep needs to log accurately, not a failure -- a red button
// trains reps to avoid logging it, and log rate matters more than
// sentiment. Same reasoning tests/web-leads-guards.test.ts already pins for
// WebsiteComparison's score colours.
// ---------------------------------------------------------------------------
for (const cls of ["text-red-", "bg-red-", "text-green-", "bg-green-"]) {
  assert.doesNotMatch(ui, new RegExp(cls.replace(/-/g, "\\-")), `${UI} must not attach ${cls} to any outcome button`);
}

// ---------------------------------------------------------------------------
// No em dashes in user-facing strings (project rule -- they flag AI-generated
// text). Same check tests/form-handoff-copy.test.ts already runs for
// merchant-facing copy, applied here to the outcome-logging UI.
// ---------------------------------------------------------------------------
for (const [label, src] of [[UI, ui], [ROUTE, route], [LIB, lib]] as const) {
  const dashes = stripComments(src).match(/.{0,50}[—–].{0,50}/g) || [];
  assert.deepEqual(dashes, [], `em/en dash found in ${label}: ${dashes.join(" | ")}`);
}

console.log("web-leads-outcome-guards ok");
