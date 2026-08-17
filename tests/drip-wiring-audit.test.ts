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
assert.ok(executor.includes("emailGateReason(run.emailBudget, row.lead_id, brand, gateStage"),
  "the volume gate must be evaluated per-brand AND per-stage — a flat cap either " +
  "starves the hot stages or over-mails the cold ones");

// ── The per-sequence daily cap is actually consulted, and actually spent ───
// An operator can type a number into the Drips > Volume tab. If the gate is not
// passed the sequence, that number is decoration: the UI would report a cap the
// engine never reads, which is worse than having no cap at all.
assert.ok(executor.includes("emailGateReason(run.emailBudget, row.lead_id, brand, gateStage, seqRef)"),
  "the gate must receive the sequence, or a per-sequence cap set in the UI does nothing");
assert.ok(/consumeEmail\(run\.emailBudget, row\.lead_id, brand, \{/.test(executor),
  "a real send must SPEND the sequence's allowance, or the cap only bites on the next run");
assert.ok(executor.includes("loadEmailBudget(db, emailLeadIds, Array.from(leadIdsByTenant.keys()))"),
  "per-sequence caps must load for EVERY tenant in the batch — claimed[0].tenant_id is the " +
  "mistake the brand map and the template pool each had to be fixed for");
assert.ok(read("lib/drips/drip-rules-core.ts").includes("sequenceBudgetKeys"),
  "sequence budget keys must be namespaced by tenant; a sequence NAME is not unique across tenants");
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
// BOTH link directions. An application normally backlinks to its lead
// (`data.lead_id`), but the lead may instead point forward
// (`data.application_id`) with no backlink — a supported one-way shape. Reading
// only the backlink lets such a record report "no application", which for a
// suppression guard means OPEN, which means mailing a funded merchant.
{
  const store = read("lib/drips/deal-state-store.ts");
  assert.ok(store.includes('.in("data->>lead_id"'), "must resolve applications that backlink the lead");
  assert.ok(store.includes("application_id"), "and applications the LEAD points at");
}
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

// ── The drip audience is the BOARD's audience (2026-08-11) ─────────────────
// The defect: the Leads board hides leads stamped `transferred_at`, the
// enroller queried `data->>stage` directly, and 64% of all drip mail ever sent
// went to merchants Adon could not see on the board. Three places have to hold
// for that to stay fixed, so all three are asserted rather than trusted.
assert.ok(enroller.includes("applyLeadsBoardFilter("),
  "the enroller must filter candidates to what the Leads board actually shows");
assert.ok(enroller.includes('return "off_board"'),
  "and keep the in-memory guard, so dropping the query filter reports instead of mailing");
assert.ok(executor.includes("isOnLeadsBoard(data)"),
  "dispatch must re-check: a lead is usually transferred AFTER its steps are queued");
assert.ok(executor.includes("off_board: lead transferred"),
  "a cancelled row must say why, or a silent stop is indistinguishable from a bug");
assert.ok(read("lib/manifest/data.ts").includes("applyLeadsBoardFilter("),
  "the BOARD must read the same rule, or the two drift apart again");
// The board-exit edge has no status change at all — transferred_at is stamped
// while stage stays put — so the eager cancel needs its own signal.
assert.ok(read("lib/manifest/data.ts").includes("detectBoardExit("),
  "updateRecord must detect the board exit; detectStatusTransitions cannot see it");
assert.ok(read("lib/portals/stage-hooks.ts").includes("BOARD_EXIT_FIELD"),
  "and the portal hook must act on it");
// Order matters: off-board must be decided BEFORE the stage recheck, because it
// is the stronger statement — no stage sequence may speak to a transferred lead.
assert.ok(
  executor.indexOf("isOnLeadsBoard(data)") < executor.indexOf("stage_changed: lead now at"),
  "the off-board check must precede the stage recheck",
);

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
// Both channels now resolve through brandForSend, which is stage-first BY
// CONSTRUCTION rather than by each call site remembering to put brandForStage
// first (2026-08-17). That is strictly stronger: the old `brandForStage(stage)
// ?? stamp ?? "sunbiz"` chain let a stage with no rule fall through to the
// stamp, and initialBrandFor stamps bluerise on any cold lead — so Bluerise
// could speak for a stage nobody assigned it to.
assert.ok(
  (executor.match(/brandForSend\(\{/g) || []).length >= 2,
  "BOTH the email and SMS brand resolutions must go through brandForSend",
);
assert.ok(
  !/brandForStage\(data\.stage\) \?\? run\.brandByLead/.test(executor),
  "the stage-then-stamp chain must be gone — a stamp cannot promote a lead to Bluerise",
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
