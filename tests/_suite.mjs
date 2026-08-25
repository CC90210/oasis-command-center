/**
 * Runs the SunBiz suite, one node process per test, stopping at the first
 * failure — exactly what the `&&` chain in package.json used to do.
 *
 * WHY THIS EXISTS
 * The chain was a single command line naming every test. On 2026-08-14 it hit
 * the Windows limit and node refused to start: "The command line is too long."
 * The whole suite failed, and the only signal was that error — not a test name.
 * Adding one more test would have broken it for everyone on Windows.
 *
 * The list stays EXPLICIT rather than globbed. Membership here is deliberate:
 * tests/turso-auth-admin.test.ts exists and is deliberately not in this suite,
 * and a glob would silently adopt every future file, including ones that need
 * credentials or a live database.
 *
 * Adding a test: put it in the list. There is no other step.
 */
import { spawnSync } from "node:child_process";

const TESTS = [
  "tests/alert-decay.test.ts",
  "tests/lead-source-attribution.test.ts",
  "tests/lead-source-rollup.test.ts",
  "tests/sunbiz-form-templates.test.ts",
  "tests/public-form-resolver.test.ts",
  "tests/public-form-origin.test.ts",
  "tests/sunbiz-import-routing.test.ts",
  "tests/lead-transfer-canonical.test.ts",
  "tests/pipeline-turnkey-lifecycle.test.ts",
  "tests/founder-booking-ui.test.ts",
  "tests/founder-meeting-calendar.test.ts",
  "tests/founder-meeting-closed-loop.test.ts",
  "tests/founder-meeting-service.test.ts",
  "tests/google-workspace-calendar-readiness.test.ts",
  "tests/oasis-mutation-bypass-guards.test.ts",
  "tests/website-sales-build-brief.test.ts",
  "tests/website-sales-payment-verification.test.ts",
  "tests/website-sales-payment-reconciliation.test.ts",
  "tests/commission-payout-workflow.test.ts",
  "tests/atomic-pipeline-lifecycle.test.ts",
  "tests/oasis-pipeline-query.test.ts",
  "tests/oasis-sales-motion-split.test.ts",
  "tests/oasis-claim-touch-cutover.test.ts",
  "tests/canonical-touch-concurrency.test.ts",
  "tests/pipeline-lead-mutation-access.test.ts",
  "tests/bulk-email-canonical-touch.test.ts",
  "tests/auth-routing.test.ts",
    "tests/invite-existing-account-recovery.test.ts",
    "tests/turso-session-version.test.ts",
    "tests/auth-oauth-continuation.test.ts",
  "tests/auth-email-sender.test.ts",
  "tests/middleware-prefix.test.ts",
  "tests/pipeline-inline-stage.test.ts",
  "tests/onboarding-gate.test.ts",
  "tests/agent-display-name.test.ts",
  "tests/employee-scoped-pipeline.test.ts",
  "tests/user-credential-resolver.test.ts",
  "tests/team-invites.test.ts",
  "tests/url-safety.test.ts",
  "tests/lead-staleness.test.ts",
  "tests/setup-readiness.test.ts",
  "tests/seat-warning.test.ts",
  "tests/role-agent-defaults.test.ts",
  "tests/conversations-grouping.test.ts",
  "tests/dashboard-send-mode.test.ts",
  "tests/bridge-exec-tool-role-gate.test.ts",
  "tests/settings-agent-roster.test.ts",
  "tests/settings-bridge-consistency.test.ts",
  "tests/local-cli-heartbeat-status.test.ts",
  "tests/intent-inquiry-lifecycle.test.ts",
  "tests/us-address.test.ts",
  "tests/application-disclosure.test.ts",
  "tests/application-pdf-rendered.test.ts",
  "tests/application-pdf.test.ts",
  "tests/forms-visibility.test.ts",
  // Delete reported 404 AFTER deleting the row: the Turso adapter swallowed
  // `{ count: "exact" }` on delete/update. Runs the real adapter against a
  // real in-memory libSQL db and pins create+delete to one resolveTenantId.
  "tests/forms-delete-tenant-scope.test.ts",
  // The form builder was SunBiz-hardcoded for every tenant. Pins the tenant
  // boundary: sun keeps its presets, nobody else ever sees them, unknown
  // tenants get NO stage vocabulary (fail closed).
  "tests/forms-tenant-scoping.test.ts",
  "tests/oasis-funnel.test.ts",
  "tests/lead-scope.test.ts",
  // Sits beside lead-scope deliberately: both defend "who may see which rows".
  // lead-scope covers per-agent lead visibility; role-surfaces covers which
  // whole SURFACE each persona gets, and proves the rep's Today never fetches
  // company financials. Same class as portal-boundaries and
  // marketing-founders-gate below — a security boundary belongs in the suite
  // everyone runs, not only in the website-sales script.
  "tests/role-surfaces.test.ts",
  "tests/agent-api-scope.test.ts",
  "tests/fetch-json.test.ts",
  // The Automations board crashed for weeks here: normalizeEmpireRow had no
  // test and met a data layer that hands back objects where text was declared.
  "tests/cron-empire-row.test.ts",
  "tests/fuzzy-match.test.ts",
  "tests/infer-result-text.test.ts",
  "tests/csv-combine.test.ts",
  "tests/sunbiz-events-format.test.ts",
  "tests/application-upsert.test.ts",
  "tests/live-sub-mapping.test.ts",
  "tests/crm-write-role-gate.test.ts",
  "tests/funmate-integration.test.ts",
  "tests/agent-events-tenant-scope.test.ts",
  "tests/activity-log-tenant-isolation.test.ts",
  "tests/auth-email-sender.test.ts",
  "tests/drip-email-telemetry.test.ts",
  "tests/lender-reply-classify.test.ts",
  "tests/lender-auto-route.test.ts",
  "tests/clair-manual-only.test.ts",
  "tests/underwriting-manual-only.test.ts",
  "tests/renewals-derive.test.ts",
  "tests/marketing-core.test.ts",
  "tests/marketing-founders-gate.test.ts",
  "tests/portal-boundaries.test.ts",
  "tests/shell-boundary.test.ts",
  "tests/font-selfhost.test.ts",
  "tests/asset-platforms.test.ts",
  "tests/asset-carousel.test.ts",
  "tests/slide-reorder.test.ts",
  "tests/performance-metrics.test.ts",
  "tests/performance-page-render.test.ts",
  "tests/marketing-degraded-render.test.ts",
  "tests/unique-violation-classifier.test.ts",
  "tests/chunk-salvage.test.ts",
  "tests/outreach-chunk-failure.test.ts",
  "tests/url-token-redaction.test.ts",
  "tests/db-error-contract.test.ts",
  "tests/portal-stage-hooks.test.ts",
  "tests/founders-ingest-core.test.ts",
  "tests/partial-index-upsert.test.ts",
  "tests/watermark-copy-path.test.ts",
  "tests/drip-engine-repair.test.ts",
  "tests/email-tracking-domain.test.ts",
  "tests/email-sending-identity.test.ts",
  "tests/brand-registry.test.ts",
  "tests/shopout-brand-lock.test.ts",
  "tests/brand-routing.test.ts",
  "tests/drip-deal-state.test.ts",
  "tests/drip-board-parity.test.ts",
  "tests/live-subs-visibility.test.ts",
  "tests/brand-suppression-invariants.test.ts",
  "tests/brand-shell.test.ts",
  "tests/drip-template-pool.test.ts",
  "tests/sms-compliance.test.ts",
  "tests/drip-wiring-audit.test.ts",
  "tests/accelerated-live-subs-only.test.ts",
  "tests/shopping-out-transfer-audit.test.ts",
  "tests/per-stage-cadence.test.ts",
  "tests/sms-consent.test.ts",
  "tests/health-checks.test.ts",
  "tests/health-coverage.test.ts",
  "tests/sms-sender-sync.test.ts",
  "tests/sms-carrier-status.test.ts",
  "tests/outbound-routing.test.ts",
  "tests/consent-capture.test.ts",
  "tests/channel-fallback.test.ts",
  "tests/sms-lawful-basis.test.ts",
  "tests/shopout-dispatch-honesty.test.ts",
  "tests/cron-driver-coverage.test.ts",
  // Sits beside cron-driver-coverage deliberately: that one proves every
  // registered cron has something driving it, this one proves the one cron
  // that must NOT be driven can't be armed from the dashboard.
  "tests/daemon-backed-crons.test.ts",
  "tests/merchant-email-wiring.test.ts",
  "tests/bulk-email-dispatch.test.ts",
  "tests/bulk-email-compose.test.ts",
  "tests/bulk-email-visibility.test.ts",
  "tests/sunbiz-application-chase.test.ts",
  "tests/form-handoff-copy.test.ts",
  "tests/email-idempotency-marker.test.ts",
  "tests/watermark-large-pdf.test.ts",
  "tests/drip-activity.test.ts",
  "tests/template-interchange.test.ts",
  "tests/template-pool-store.test.ts",
  "tests/health-panel.test.ts",
  "tests/shopout-sender-locality.test.ts",
  "tests/sequence-volume.test.ts",
  "tests/pg-bridge-operators.test.ts",
  "tests/or-filter-dotted-values.test.ts",
  "tests/form-submit-failure-capture.test.ts",
  "tests/form-submission-integrity.test.ts",
  "tests/deploy-serves-main.test.ts",
  "tests/telegram-lane-fallback.test.ts",
  "tests/rep-line-isolation.test.ts",
  "tests/email-drip-health.test.ts",
  "tests/ai-wire.test.ts",
  "tests/tcpa-fallback-window.test.ts",
  "tests/founders-method-guard.test.ts",
  "tests/sms-only-and-brand-lock.test.ts",
  "tests/reply-handoff.test.ts",
  "tests/sms-pacing.test.ts",
  "tests/optout-cooloff.test.ts",
  "tests/channel-limits.test.ts",
  "tests/offboard-stages.test.ts",
  "tests/audience-narrowing.test.ts",
  "tests/client-automation-profiles.test.ts",
  // Beside it deliberately: the profile module decides WHO a client's replies
  // come from, and this covers the rules that decision must satisfy.
  "tests/reply-identity.test.ts",
  // tests/client-automation-lifecycle.test.ts was registered here (1b58d49c)
  // but its file and the 150_reply_identity_pairing migration it builds from
  // were never committed — and main has since shipped a different migration
  // 150. Re-register it when the reply-identity work lands with a renumbered
  // migration; until then the registration pointed at nothing.
  // APEX's Web Leads browser (PR #242).
  "tests/web-leads-filters.test.ts",
  "tests/web-leads-queries.test.ts",
  "tests/web-leads-data.test.ts",
  "tests/web-leads-counters.test.ts",
  "tests/web-leads-guards.test.ts",
  "tests/pipeline-web-lead-facts.test.ts",
  "tests/web-leads-filter-memory.test.ts",
  "tests/parked-domains.test.ts",
  "tests/web-leads-scope.test.ts",
  // Openers and closers. The 2026-08-21 job titles replaced `agent`, but the
  // scoping predicate and the deal gate still only knew the legacy name --
  // so a Closer could not close and an Opener saw the whole tenant.
  "tests/rep-role-capabilities.test.ts",
  // 2026-08-23 sales pass: the score now appears in the LIST as well as the
  // detail panel, read from a different table by a different query. This proves
  // the two can never contradict each other about a stranger's website -- and
  // that Call Mode cannot advance past a call it failed to record.
  "tests/web-leads-scores.test.ts",
  // 2026-08-23 ownership pass: who holds a lead, and when that stops being
  // true. Guards the two failures that are invisible on a screen -- two reps
  // dialling the same business, and a pool that only ever drains.
  "tests/web-leads-claim.test.ts",
  // Task 2 (2026-08-21 build-a-lead-detail plan): rep-facing remedy copy ported
  // from JARVIS's services/leadgen/lib/remedies.js.
  "tests/web-leads-remedies.test.ts",
  // Task 3 hotfix (2026-08-21): proves the Turso adapter's object-vs-string
  // profile decoding is handled -- see coerceProfile() in lib/web-leads/audit.ts.
  "tests/web-leads-audit.test.ts",
  // Task 4 P2 fix (2026-08-21, independent review): the "View website" link
  // must not treat a bare domain as app-relative, and must allowlist
  // http/https against OSM-sourced data anyone can edit -- see
  // lib/web-leads/url-safety.ts.
  "tests/web-leads-url-safety.test.ts",
  // Build C (2026-08-21 leads-to-pipeline-design.md, section 5): logging a
  // call outcome is the byproduct that advances the lead's stage. nextStage()
  // is the constrained, pure stage-advance function -- see
  // lib/web-leads/outcome.ts's header for the full reasoning.
  "tests/web-leads-outcome.test.ts",
  "tests/web-leads-outcome-idempotency.test.ts",
  "tests/web-leads-outcome-guards.test.ts",
  // (The shared pipeline board and its tests were removed 2026-08-23. It
  // showed every rep's leads mixed together, which answers a manager's
  // question on a screen only reps use -- Adon: "I don't see any use for
  // that." Replaced by the per-rep My Leads view, covered by
  // web-leads-claim.test.ts. CC's WEBSITE_SALES_STAGES remain the single
  // lifecycle; nothing about that changed.)
  // Build B (2026-08-21): territory -> rep assignment. Admin-only enforcement,
  // tenant mismatch, propagation to the right leads, and the rule that an
  // unassign must never strip a lead's own data.assigned_to.
  "tests/web-leads-territory-assign.test.ts",
  // The battle card (2026-08-24). Guards the numbers a rep says out loud: the
  // percentile understates on a tie, the peer group is never quoted below
  // MIN_SLICE and never silently widened, the evidence never prints a
  // measurement the crawler did not take, and a non-scored site gets a sentence
  // rather than a radar with seven axes at the origin. Plus the auth gate on
  // the new endpoint, and the rule that a competitor is a measurement of a
  // public business, never a lead out of another rep's book.
  "tests/web-leads-battlecard.test.ts",
  // Opening hours and the CRTC calling window (2026-08-24). Canada has six time
  // zones, Saskatchewan refuses daylight saving, Newfoundland is offset by half
  // an hour, and Rule 23 measures the legal calling window in the RECIPIENT's
  // local time -- so a Toronto rep dialling Vancouver at 9am is calling at 6am,
  // which is a violation at up to $15,000 per call. This pins all four of those
  // against fixed instants on both sides of a DST transition.
  "tests/web-leads-hours.test.ts",
  // The ONLY web-leads test that touches a database. Everything else here
  // covers a pure rule module, so the read/filter/sort/page path that decides
  // what a rep actually sees had no coverage at all until 2026-08-25. Runs
  // against a real in-memory libSQL file, and was watched to fail against both
  // a dead phase-2 read and a reverted selectCol().
  "tests/web-leads-list-read.test.ts",
  // The PostgREST adapter's own conformance suite, against a real in-memory
  // libSQL database. It existed since the adapter was written and was never in
  // this list, so nothing ran it but a human remembering to.
  //
  // Added 2026-08-25 because the Web Leads list read now depends on one of its
  // guarantees: lib/web-leads/data.ts projects JSON paths in `select()`, and
  // that is only safe because selectCol() names the output column the way
  // PostgREST does. Unpinned, a change to the select compiler would break the
  // leads list on the supabase-js path only -- silently, and nowhere near the
  // file that got edited. This is the same failure shape as
  // `.is("profile","not.null")` (lib/web-leads/scores.ts), which is exactly the
  // bug class the adapter tests exist to catch.
  "lib/__tests__/turso-postgrest.test.mjs",
];

const NODE_ARGS = ["--conditions=react-server", "--import", "tsx"];

let failed = null;
for (const file of TESTS) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, file], { stdio: "inherit" });
  if (r.status !== 0) {
    failed = { file, status: r.status, signal: r.signal };
    break;
  }
}

if (failed) {
  // Name the file. The old chain's failure output left you scrolling a 9,000
  // character command to work out which one stopped it.
  console.error(
    `\n[test:sunbiz] FAILED in ${failed.file}` +
      (failed.signal ? ` (signal ${failed.signal})` : ` (exit ${failed.status})`) +
      `\n[test:sunbiz] ${TESTS.indexOf(failed.file)} of ${TESTS.length} passed before it.`,
  );
  process.exit(failed.status || 1);
}

console.log(`\n[test:sunbiz] ${TESTS.length} test files passed.`);
