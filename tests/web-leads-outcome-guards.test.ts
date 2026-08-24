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
// THE LEAD WRITE IS BUILT BY THE CANONICAL SEAM, NOT ASSEMBLED HERE.
//
// This assertion used to require the literal `patch: { stage: target }`, back
// when advancing the stage was the only thing a logged call did. It now also
// stamps last_disposition / last_contact_at / next_action_at -- the fields
// Rep Today ranks and labels on -- so the shape changed, but the property that
// mattered has not: a rep pressing a button on a call must never be able to
// move money, price or ownership.
//
// So the check is now stronger rather than merely different. The patch object
// must come from lib/website-sales-workflow.ts (one owner of what a
// disposition means, which is what stopped the two vocabularies drifting), and
// the ONLY literal object handed to updateRecord in this file is that variable.
// ---------------------------------------------------------------------------
assert.match(
  libCode,
  /callDispositionPatch\(/,
  `${LIB} must build its lead patch with callDispositionPatch, not assemble one locally`,
);
assert.match(
  lib,
  /@\/lib\/website-sales-workflow/,
  `${LIB} must import the canonical workflow seam`,
);
const updateCalls = libCode.match(/updateRecord\(\{[\s\S]{0,400}?\}\);/g) || [];
assert.ok(updateCalls.length > 0, `${LIB} must call updateRecord() to apply the disposition`);
// TWO legitimate lead writes live in this module, and no third:
//
//   1. the disposition patch, built entirely by the canonical seam;
//   2. the calendar bookkeeping write, which stores the event id Google
//      assigned to this lead's reminder so the next push updates that event
//      instead of creating a second one.
//
// The second is deliberately allowed to be an inline object because it is ONE
// mirror field with no lifecycle meaning -- but it is named explicitly here, so
// a third inline patch cannot ride in beside it.
const ALLOWED_INLINE = /patch:\s*\{\s*\[NEXT_ACTION_EVENT_ID_FIELD\]:/;
for (const call of updateCalls) {
  const seamBuilt = /patch(:\s*patch)?\s*[,}]/.test(call);
  const bookkeeping = ALLOWED_INLINE.test(call);
  assert.ok(
    seamBuilt || bookkeeping,
    `${LIB}'s updateRecord() must pass the seam-built patch, or the one permitted calendar-id bookkeeping patch -- never a new inline object`,
  );
  for (const forbiddenField of ["price", "commission", "setupAmount", "monthlyAmount", "collectedSetupAmount", "assigned_to"]) {
    assert.doesNotMatch(
      call,
      new RegExp(forbiddenField, "i"),
      `${LIB}'s updateRecord() patch must never touch "${forbiddenField}"`,
    );
  }
}
// The bookkeeping write must exist and must carry exactly one key. A second key
// creeping in here would be a lifecycle write dressed as mirror bookkeeping.
const bookkeepingCall = updateCalls.find((c) => ALLOWED_INLINE.test(c));
assert.ok(bookkeepingCall, `${LIB} must persist the calendar event id back onto the lead`);
const patchObject = bookkeepingCall!.match(/patch:\s*\{([\s\S]*?)\}/);
assert.ok(patchObject, "the bookkeeping patch object must be readable");
assert.equal(
  (patchObject![1].match(/:/g) || []).length,
  1,
  "the calendar bookkeeping patch must carry exactly one field",
);

// And the seam itself must not emit a commercial field, which is what makes
// the check above meaningful rather than merely structural. Asserted against
// the real function over every disposition in tests/web-leads-next-action.ts;
// this is the source-level companion so a new key cannot be added quietly.
const workflow = read("lib/website-sales-workflow.ts");
for (const forbiddenField of ["price", "commission", "setupAmount", "collectedSetupAmount", "assigned_to"]) {
  assert.doesNotMatch(
    stripComments(workflow),
    new RegExp(`${forbiddenField}\\s*:`, "i"),
    `lib/website-sales-workflow.ts must never put "${forbiddenField}" in a disposition patch`,
  );
}

// ---------------------------------------------------------------------------
// THE REPAIR ROUTE IS THE SAME BOUNDARY, NOT A LIGHTER ONE.
//
// Logging a call is two writes that cannot be made atomic here, so a failed
// second write answers 409 and POST outcome/reconcile rebuilds the lead's
// queue fields from the append-only history. That route writes to
// tenant_records, so a weaker gate on it would simply be the way in -- and a
// repair endpoint is exactly the kind of thing that gets written as an
// afterthought with a lighter check.
// ---------------------------------------------------------------------------
const RECONCILE = "app/api/web-leads/[id]/outcome/reconcile/route.ts";
const reconcile = read(RECONCILE);
assert.match(reconcile, /resolveSessionContext/, `${RECONCILE} must resolve the caller`);
assert.match(reconcile, /if\s*\(\s*!\s*session\.ok\s*\)/, `${RECONCILE} must branch on session.ok, not truthiness`);
assert.match(reconcile, /status:\s*401/, `${RECONCILE} must fail closed on an unresolved caller`);
assert.match(reconcile, /session\.tenantId/, `${RECONCILE} must constrain the caller to the tenant`);
assert.match(reconcile, /status:\s*403/, `${RECONCILE} must refuse another tenant with a 403`);
assert.match(reconcile, /fetchLead\(/, `${RECONCILE} must resolve the lead through fetchLead so agent scoping applies`);
assert.match(reconcile, /status:\s*404/, `${RECONCILE} must 404, not 403, for a lead outside the viewer's scope`);
assert.match(reconcile, /session\.teamRole/, `${RECONCILE} must reference session.teamRole when building the viewer`);
assert.match(reconcile, /session\.isAdmin/, `${RECONCILE} must reference session.isAdmin when building the viewer`);
// It repairs; it must never append. A reconcile that logged a row would turn
// one conversation into two every time a rep pressed Retry.
assert.doesNotMatch(
  stripComments(reconcile),
  /leadgen_call_outcomes/,
  `${RECONCILE} must not touch the history table directly -- it reconciles FROM it`,
);
assert.doesNotMatch(stripComments(reconcile), /\.insert\(/, `${RECONCILE} must not insert anything`);

// The repair must be reported honestly: "nothing to repair" is not "repaired".
assert.match(
  reconcile,
  /repaired:\s*false/,
  `${RECONCILE} must distinguish "nothing to repair" from a successful repair`,
);

// ---------------------------------------------------------------------------
// Tenant scoping on the write itself -- libSQL has no row-level security, so
// the insert must pin WEBDEV_TENANT_ID explicitly, the same convention every
// other write and read in this feature follows.
// ---------------------------------------------------------------------------
assert.match(libCode, /tenant_id:\s*WEBDEV_TENANT_ID/, `${LIB} must pin WEBDEV_TENANT_ID on the leadgen_call_outcomes insert`);

// ---------------------------------------------------------------------------
// No colour keyed to sentiment on ANY of the eight buttons. "Not interested" is
// information a rep needs to log accurately, not a failure -- a red button
// trains reps to avoid logging it, and log rate matters more than
// sentiment. Same reasoning tests/web-leads-guards.test.ts already pins for
// WebsiteComparison's score colours.
// ---------------------------------------------------------------------------
const CALL_MODE = "components/web-leads/CallMode.tsx";
const callMode = read(CALL_MODE);
for (const [label, src] of [[UI, ui], [CALL_MODE, callMode]] as const) {
  for (const cls of ["text-red-", "bg-red-", "text-green-", "bg-green-"]) {
    assert.doesNotMatch(src, new RegExp(cls.replace(/-/g, "\\-")), `${label} must not attach ${cls} to any outcome button`);
  }
}

// Every disposition must be reachable from both surfaces. A vocabulary that is
// wide in the data layer and narrow on one screen is how "no answer" ended up
// standing in for three different problems for months.
for (const [label, src] of [[UI, ui], [CALL_MODE, callMode]] as const) {
  for (const disposition of ["no_answer", "voicemail", "gatekeeper", "connected", "callback", "interested", "not_interested", "do_not_call"]) {
    assert.match(src, new RegExp(`"${disposition}"`), `${label} must offer the "${disposition}" disposition`);
  }
}

// ---------------------------------------------------------------------------
// No em dashes in user-facing strings (project rule -- they flag AI-generated
// text). Same check tests/form-handoff-copy.test.ts already runs for
// merchant-facing copy, applied here to the outcome-logging UI.
// ---------------------------------------------------------------------------
for (const [label, src] of [[UI, ui], [ROUTE, route], [LIB, lib], [CALL_MODE, callMode], [RECONCILE, reconcile]] as const) {
  const dashes = stripComments(src).match(/.{0,50}[—–].{0,50}/g) || [];
  assert.deepEqual(dashes, [], `em/en dash found in ${label}: ${dashes.join(" | ")}`);
}

console.log("web-leads-outcome-guards ok");
