/**
 * tests/drip-wiring-audit.test.ts — is the whole chain actually connected?
 *
 * Every piece of this build is individually tested. This file asserts the
 * pieces are WIRED, because the failure mode that survives unit tests is a
 * correct module nobody calls. The 2026-08-05 audit found exactly that twice:
 * the drip engine never read cc_email_templates, and SUNBIZ_LEGAL_FOOTER was
 * imported only by the per-rep senders.
 *
 * Structural assertions over source text. Blunt on purpose: they should fail
 * loudly when a refactor disconnects something, not silently pass.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");

const executor = read("lib/drips/executor.ts");
const enroller = read("lib/drips/enroller.ts");
const governor = read("lib/drips/governor.ts");
const trackedHtml = read("lib/email/tracked-html.ts");
const send = read("lib/drips/send.ts");
const gmailSend = read("lib/integrations/submissions-gmail-send.ts");
const gmail = read("lib/integrations/submissions-gmail.ts");
const optOut = read("lib/sms-opt-out.ts");

// ── Brand flows all the way to the wire ────────────────────────────────────
assert.ok(enroller.includes("ensureInitialBrand"), "enroller must stamp the brand at enrolment");
assert.ok(executor.includes("loadBrandsForLeads"), "executor must load brands per run");
assert.ok(executor.includes("run.brandByLead.get"), "executor must resolve the brand per row");
assert.ok(executor.includes("sendingBrand: brand"), "the HTML shell must receive the sending brand");
// Scope to the actual call's argument object rather than a fixed character
// window — an explanatory comment inside the call should not fail this.
{
  const at = executor.indexOf("await sendDripEmail(");
  assert.ok(at > 0, "the executor must call sendDripEmail");
  const callBlock = executor.slice(at, executor.indexOf("});", at));
  assert.ok(/^\s*brand,\s*$/m.test(callBlock), "the send call must pass the brand");
  assert.ok(callBlock.includes("html"), "and the rendered html");
}
assert.ok(send.includes("brand,"), "sendDripEmail must forward the brand to sendGmail");
assert.ok(gmailSend.includes("getSubmissionsCreds(payload.tenantId, payload.brand)"),
  "the SMTP credential must be selected BY BRAND — this is what actually moves the mail");
assert.ok(gmail.includes("getBrand(resolveBrandKey(brand)).credentialService"),
  "credential lookup must route through the brand registry");

// ── The brand is recorded on what was actually sent ────────────────────────
assert.ok(executor.includes("sending_brand: sentBrand"),
  "the interaction row must record the brand ACTUALLY sent, not the lead's current one");

// ── CAN-SPAM postal address reaches BOTH html paths ────────────────────────
assert.ok(trackedHtml.includes("brandFooter"), "buildTrackedHtml must render the brand footer");
assert.ok(executor.includes("brandFooter("),
  "the custom-HTML path must ALSO render it, or templated drips ship with no address");

// ── Volume caps see every sender and are per-brand ─────────────────────────
assert.ok(!governor.includes('.eq("metadata->>dry_run", "false")'),
  "the cap must not filter on dry_run='false' exactly — that made a second sender invisible");
assert.ok(governor.includes('String(md.dry_run) === "true"'),
  "only an EXPLICIT dry run may be excluded from the count");
assert.ok(governor.includes("countDripEmailByBrand"), "counts must be per-brand");
assert.ok(executor.includes("emailGateReason(run.emailBudget, row.lead_id, brand, gateStage)"),
  "the volume gate must be evaluated per-brand AND per-stage — a flat cap either " +
  "starves the hot stages or over-mails the cold ones");
assert.ok(read("lib/drips/drip-rules-core.ts").includes("perLeadCapForStage"),
  "the per-stage cap must exist");

// The brand must be resolved BEFORE the gate, or the gate cannot use it.
assert.ok(
  executor.indexOf("const brand: BrandKey") < executor.indexOf("emailGateReason(run.emailBudget"),
  "brand resolution must precede the volume gate",
);

// ── The deal gate is wired at BOTH ends (2026-08-11) ───────────────────────
// The bug it closes: the drip triggers on the LEAD's stage while the deal's
// real state lives on the APPLICATION's status, and nothing syncs them — so a
// funded, declined or dead merchant stays parked in `signed_application` and
// keeps being chased for bank statements. Enrolment alone is not enough (a deal
// that closes AFTER enrolment sails through) and dispatch alone is not enough
// (the run is created, counted and paced first), so both must call it.
assert.ok(enroller.includes("loadDealGates("), "the enroller must gate NEW enrolments on the deal's state");
assert.ok(enroller.includes('noteSkip("deal_closed")'), "and record why a lead was skipped");
assert.ok(executor.includes("loadDealGate("), "dispatch must re-check: a deal can close mid-sequence");
assert.ok(executor.includes("deal_closed: application is"),
  "a cancelled row must name the status that closed it, or nobody can audit a silent stop");
// The dispatch-time read must never CANCEL on a read failure — that would turn
// a transient database hiccup into permanent silent lead loss.
{
  const at = executor.indexOf("deal_state_unavailable");
  assert.ok(at > 0, "a failed deal-state read must be reported by name");
  const block = executor.slice(Math.max(0, at - 400), at);
  assert.ok(block.includes("markRescheduled"),
    "a failed deal-state read must RESCHEDULE, never cancel");
}

// ── A cold sending domain does not inherit a warmed one's ceiling ──────────
// Routing the follow-ups desk to Bluerise points 512 leads at a domain with no
// sending history. Falling through to the shared 150/day default would open it
// at the END of a six-week warm-up rather than the start.
assert.ok(governor.includes('brand === "bluerise" ? WARMUP_START_DAILY'),
  "bluerise must carry its own warm-up daily default, not inherit DRIPS_EMAIL_DAILY_CAP");
assert.ok(governor.includes('brand === "bluerise" ? WARMUP_START_HOURLY'),
  "and its own hourly default");

// ── Stage decides the mailbox, and it decides BOTH channels ────────────────
// Adon 2026-08-11: submissions@ carries viewed + signed, Bluerise carries the
// follow-ups tab. Email-only routing would email a merchant as one company and
// text them as the other; 10DLC registration is per brand.
assert.ok(
  (executor.match(/brandForStage\(data\.stage\)/g) || []).length >= 2,
  "BOTH the email and SMS brand resolutions must be stage-first",
);

// ── Suppression stays brand-blind and fail-closed ──────────────────────────
assert.ok(executor.includes("supp.checkFailed"), "a failed suppression check must hold, never send");
assert.ok(!/checkEmailSuppressed\([^)]*brand/.test(executor),
  "suppression must NOT be brand-scoped — an opt-out has to stop both brands");

// ── SMS compliance is wired, not just written ──────────────────────────────
assert.ok(optOut.includes("detectOptOut"),
  "isStopCommand must delegate to the permissive detector; the old anchored regex " +
  "matched only a bare keyword and produced 0 opt-outs across 600 sends");
assert.ok(!/\^\(STOP\|UNSUBSCRIBE\|QUIT\|CANCEL\|END\)\$/.test(optOut),
  "the anchored exact-match regex must be gone");
assert.ok(executor.includes("isWithinSendWindow"),
  "state-specific quiet hours must be enforced on the SMS path, not just the federal window");
assert.ok(executor.includes("tcpa.usedFallback"),
  "an unresolved timezone must still fail closed");

// ── Template pool is actually READ, not just written ───────────────────────
const pool = read("lib/drips/template-pool.ts");
assert.ok(pool.includes("status !== \"approved\""), "approval must be a filter, not a sort");
assert.ok(pool.includes("stableIndex"), "selection must reuse the proven deterministic hash");

// This is the exact failure this codebase already produced once: the drip
// engine never read cc_email_templates, so the Templates UI edited copy that
// could not reach a merchant. The pool must not repeat it.
assert.ok(executor.includes("loadApprovedPool"), "the executor must LOAD the approved pool");
assert.ok(executor.includes("run.templatePool"), "and hold it on the run state");
assert.ok(
  (executor.match(/pool: run\.templatePool/g) || []).length >= 2,
  "BOTH the email and SMS copy paths must draw from the pool, not just one",
);
assert.ok(executor.includes("poolFor("), "the pool must be scoped by brand+stage+role before selection");
assert.ok(
  read("lib/drips/template-pool-store.ts").includes('.eq("status", "approved")'),
  "the loader must filter to approved at the query as well as in the selector",
);
// The step type must carry a role, or every step collapses into one bucket.
assert.ok(read("lib/drips/types.ts").includes("role?: string"), "DripStep must carry a role");

console.log("drip-wiring-audit.test.ts — full chain verified wired ✓");
