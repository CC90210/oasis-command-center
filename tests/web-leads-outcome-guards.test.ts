import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const ROUTE = "app/api/web-leads/[id]/outcome/route.ts";
const LIB = "lib/web-leads/outcome.ts";
const UI = "components/web-leads/CallOutcomeLog.tsx";
const CALL_MODE = "components/web-leads/CallMode.tsx";
const TURSO_MIGRATION = "database/turso/158_web_lead_outcome_idempotency.turso.sql";

const route = read(ROUTE);
const lib = read(LIB);
const ui = read(UI);
const callMode = read(CALL_MODE);

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

// GET remains visible to every authorized viewer, but POST is a sales mutation.
// The role check must therefore live inside POST, not the shared authorize()
// helper that GET also uses.
const post = route.match(/export\s+async\s+function\s+POST[\s\S]*$/)?.[0] || "";
assert.match(post, /mayWorkWebsiteSalesLifecycle\(/, `${ROUTE} POST must use the centralized sales-role gate`);
assert.match(post, /status:\s*403/, `${ROUTE} POST must refuse read-only and non-sales roles`);
assert.match(post, /leadMutationAccess\(auth\.session, id\)/, `${ROUTE} POST must prove ownership after proving the sales role`);
assert.match(route, /accessMode:\s*"owned_oasis_sales"/, `${ROUTE} must use the centralized OASIS ownership policy`);
const authorizeFn = route.match(/async function authorize\([\s\S]*?\n\}/)?.[0] || "";
assert.doesNotMatch(
  authorizeFn,
  /mayWorkWebsiteSalesLifecycle\(/,
  `${ROUTE} must preserve GET visibility instead of applying the mutation gate in shared authorization`,
);
assert.match(route, /canMutate:\s*mutationAccess\.ok/, `${ROUTE} GET must return the per-lead mutation decision without hiding history`);

// Durable idempotency is end-to-end: both clients generate and retain a UUID,
// the route requires it, the call row stores it under a unique DB constraint,
// and the timeline row uses the ledger's existing provider/message key.
assert.match(post, /requestId/, `${ROUTE} POST must require the client-stable request id`);
assert.match(post, /isCallOutcomeRequestId/, `${ROUTE} must reject malformed request ids before writing`);
for (const [file, source] of [[UI, ui], [CALL_MODE, callMode]] as const) {
  assert.match(source, /crypto\.randomUUID\(\)/, `${file} must mint a request id client-side`);
  assert.match(source, /requestId/, `${file} must send and retain its request id across an uncertain retry`);
}
assert.match(ui, /body\.canMutate === true/, `${UI} must hide outcomes until the GET proves per-lead ownership`);

const manifestData = read("lib/manifest/data.ts");
assert.match(manifestData, /ifMatchAll\?:/, "updateRecord must expose multi-fact CAS for owner plus lifecycle/touch guards");
assert.match(manifestData, /for \(const condition of input\.ifMatchAll\)/, "every multi-fact CAS condition must ride on the same update");
assert.match(lib, /request_id:/, `${LIB} must persist the client request id on the durable outcome row`);
assert.match(lib, /provider:\s*"web_leads_outcome"/, `${LIB} must use the existing durable timeline dedupe key`);
assert.match(lib, /provider_message_id:\s*requestId/, `${LIB} must bind the timeline row to the same request id`);
assert.match(lib, /isUniqueViolationError/, `${LIB} must distinguish a real replay from other insert failures`);
assert.match(
  lib,
  /throw new CallOutcomeSaveError\(\s*"tracking_failed"/,
  `${LIB} must make a failed timeline write retryable instead of abandoning closed-loop tracking behind a success`,
);
assert.ok(
  lib.indexOf("await persistCanonicalLeadTouch(db") < lib.indexOf("const contextPatch: Record<string, unknown>"),
  `${LIB} must establish the monotonic call timestamp before writing mutable disposition/note context`,
);
assert.match(lib, /stage_changed:\s*stageChangedTo !== null/, `${LIB} timeline metadata must report only an applied transition`);
assert.match(lib, /stageChangedTo,\s*trackingWarning/, `${LIB} must return the applied transition, not the originally planned target`);
assert.match(lib, /routingAfterOutcomeSaved/, `${LIB} must convert post-insert read failures into resumable saved-state errors`);
assert.match(lib, /fallbackLeadId/, `${LIB} must accept the original lead-id fallback after source-pointer backfill`);

for (const migrationPath of [TURSO_MIGRATION]) {
  const migration = read(migrationPath);
  assert.match(migration, /request_id/i, `${migrationPath} must add the durable request-id fact`);
  assert.match(migration, /unique\s+index/i, `${migrationPath} must enforce request-id uniqueness in the database`);
  assert.match(migration, /stage_from/i, `${migrationPath} must preserve the original transition on retries`);
  assert.match(migration, /stage_to/i, `${migrationPath} must preserve the original transition on retries`);
  assert.match(migration, /owner_user_id/i, `${migrationPath} must freeze the owner used by retry guards`);
}

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
// prominent comment explaining where Pipeline's explicit lifecycle controls
// take over, so a future editor cannot widen it without also deleting the
// reasoning that argues against that.
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
  /Pipeline's explicit lifecycle[\s\S]*?take over/,
  `${LIB} must document that Pipeline takes over qualification and the founder-meeting handoff`,
);

// nextStage's return type/callers must never touch anything beyond the owned
// early-funnel edges (attempting_contact, connected, lost). Name downstream
// stages explicitly, mirroring the exhaustive runtime check in
// tests/web-leads-outcome.test.ts with a static one over the source.
for (const forbidden of ["qualified", "founder_meeting_booked", "proposal_sent", "won", "onboarding"]) {
  assert.doesNotMatch(
    libCode,
    new RegExp(`return\\s+"${forbidden}"`),
    `${LIB} must never return "${forbidden}" from nextStage`,
  );
}

// ---------------------------------------------------------------------------
// The tenant_records writes in this feature are limited to the constrained
// early stage plus canonical touch/disposition/handoff context. Pricing,
// commission and downstream lifecycle fields remain forbidden.
// ---------------------------------------------------------------------------
// RESTATED AS AN ALLOWLIST 2026-08-23, NOT RELAXED. This required the patch to
// be literally `{ stage: target }`. Ownership expiry (lib/web-leads/claim.ts)
// needs two timestamps stamped at exactly this moment -- last_call_at on every
// logged call, lost_at on the transition into lost -- and until they were
// written, BOTH recycling rules were inverted in production while every test
// stayed green: claims expired on day 7 however hard a rep worked them, and
// lost leads never returned to the pool at all.
//
// The protection this guard exists for is unchanged: this module must never
// write a pricing, commission, or CC-owned lifecycle field. So instead of
// naming one allowed shape, it now enumerates the canonical call/touch/context
// keys that may be built into the patch, and fails on anything outside them.
const updateCalls = [...libCode.matchAll(/updateRecord\(\{[\s\S]{0,500}?\}\);/g)].map((match) => match[0]);
assert.ok(updateCalls.length >= 2, `${LIB} must CAS the stage and latest call context separately`);
assert.ok(updateCalls.some((call) => /patch:\s*stagePatch/.test(call)), `${LIB} must pass the stage patch to updateRecord()`);
assert.ok(updateCalls.some((call) => /patch:\s*contextPatch/.test(call)), `${LIB} must pass the context patch to updateRecord()`);

{
  assert.match(libCode, /const stagePatch: Record<string, unknown> = \{ stage: target \}/, `${LIB} must still advance the stage`);
  assert.match(libCode, /stagePatch\.lost_at = calledAt/, `${LIB} must stamp lost_at or the 90-day recycle can never fire`);
  assert.match(libCode, /const contextPatch: Record<string, unknown> = \{[\s\S]*?last_disposition:\s*outcome/, `${LIB} must preserve the latest call result`);
  assert.match(libCode, /ifMatchAll:[\s\S]*?assigned_to/, `${LIB} must bind stage/context writes to the frozen owner`);
  assert.match(libCode, /ifMatchAll:[\s\S]*?last_call_at/, `${LIB} must order mutable context by the canonical call timestamp`);
  assert.match(
    libCode,
    /persistCanonicalLeadTouch\([\s\S]*?isCall:\s*true/,
    `${LIB} must atomically stamp last_call_at and canonical last_contacted_at as a call`,
  );
  assert.match(
    libCode,
    /persistCanonicalLeadTouch\([\s\S]*?expectedOwnerId:\s*expectedOwner/,
    `${LIB} must bind the canonical touch write to the owner frozen with the durable outcome`,
  );
  assert.match(
    libCode,
    /record_lead_touch: owner_conflict[\s\S]*?"ownership_changed"/,
    `${LIB} must surface a touch-time transfer as an ownership conflict, not a generic retry`,
  );
}
for (const forbiddenField of ["price", "commission", "setupAmount", "monthlyAmount", "collectedSetupAmount", "assigned_to"]) {
  assert.doesNotMatch(
    libCode,
    new RegExp(`(?:stagePatch|contextPatch)\\.${forbiddenField}\\s*=`, "i"),
    `${LIB}'s assembled patches must never assign "${forbiddenField}"`,
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
