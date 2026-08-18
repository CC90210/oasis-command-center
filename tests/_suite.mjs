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
  "tests/sunbiz-form-templates.test.ts",
  "tests/public-form-resolver.test.ts",
  "tests/sunbiz-import-routing.test.ts",
  "tests/auth-routing.test.ts",
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
  "tests/intent-inquiry-lifecycle.test.ts",
  "tests/us-address.test.ts",
  "tests/application-disclosure.test.ts",
  "tests/application-pdf-rendered.test.ts",
  "tests/application-pdf.test.ts",
  "tests/forms-visibility.test.ts",
  "tests/oasis-funnel.test.ts",
  "tests/lead-scope.test.ts",
  "tests/fuzzy-match.test.ts",
  "tests/infer-result-text.test.ts",
  "tests/csv-combine.test.ts",
  "tests/sunbiz-events-format.test.ts",
  "tests/application-upsert.test.ts",
  "tests/live-sub-mapping.test.ts",
  "tests/crm-write-role-gate.test.ts",
  "tests/funmate-integration.test.ts",
  "tests/agent-events-tenant-scope.test.ts",
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
  "tests/merchant-email-wiring.test.ts",
  "tests/bulk-email-dispatch.test.ts",
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
