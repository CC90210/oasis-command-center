/** Cloud sender health must see every exact email state the PC monitor missed. */

import assert from "node:assert/strict";
import {
  DASHBOARD_EMAIL_CHECKS,
  summarizeDashboardEmailHealth,
} from "../lib/health/dashboard-email-checks";
import type { DashboardEmailQueueRow } from "../lib/leads/dashboard-email-sender";

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OASIS_WEBDEV = "42423fde-be8b-454f-932a-750e8c9b743d";
const FOREIGN = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const NOW = Date.parse("2026-10-29T23:00:00.000Z");

function row(id: string, status: string, overrides: Partial<DashboardEmailQueueRow> = {}): DashboardEmailQueueRow {
  return {
    id,
    tenant_id: OASIS,
    lead_id: crypto.randomUUID(),
    type: "email_queued",
    channel: "email",
    direction: "outbound",
    agent_source: "dashboard_drawer",
    provider: null,
    provider_message_id: null,
    subject: "Subject",
    content: "Body",
    content_preview: "Body",
    to_email: "prospect@example.com",
    metadata: { status },
    created_at: "2026-10-29T22:00:00.000Z",
    sent_at: null,
    ...overrides,
  };
}

const result = summarizeDashboardEmailHealth(
  [
    row("old-queued", "queued"),
    row("webdev-old-queued", "queued", { tenant_id: OASIS_WEBDEV }),
    row("foreign-old-queued", "queued", { tenant_id: FOREIGN }),
    row("new-queued", "queued", { created_at: "2026-10-29T22:55:00.000Z" }),
    row("due-retry", "retry", { metadata: { status: "retry", next_attempt_at: "2026-10-29T22:59:00.000Z" } }),
    row("future-retry", "retry", { metadata: { status: "retry", next_attempt_at: "2026-10-30T00:00:00.000Z" } }),
    row("expired", "sending", { metadata: { status: "sending", lease_expires_at: "2026-10-29T22:59:00.000Z" } }),
    row("live-lease", "sending", { metadata: { status: "sending", lease_expires_at: "2026-10-29T23:02:00.000Z" } }),
    row("malformed-claim", "sending", { metadata: { status: "sending", lease_expires_at: "bad", claimed_at: "bad" } }),
    row("unknown", "delivery_unknown", { metadata: { status: "delivery_unknown", needs_operator_review: true } }),
    row("failed", "failed", { metadata: { status: "failed", attempts: 5 } }),
    row("receipt-drift", "queued", {
      agent_source: "ai_audit_transactional",
      provider: "oasis_transactional_outbox",
      provider_message_id: "delivery-key",
    }),
    row("cancelled", "cancelled", {
      agent_source: "ai_audit_transactional",
      provider: "oasis_transactional_outbox",
    }),
    row("sms", "queued", { type: "sms_queued", channel: "sms", to_email: null }),
    row("bulk", "queued", { agent_source: "dashboard_bulk_email_v2" }),
  ],
  new Set(["receipt-drift"]),
  NOW,
);

assert.deepEqual(
  result.problems.map((p) => `${p.id}:${p.kind}`).sort(),
  [
    "due-retry:retry_due",
    "expired:lease_expired",
    "failed:terminal_failed",
    "malformed-claim:lease_expired",
    "old-queued:queued_stale",
    "receipt-drift:receipt_unreconciled",
    "unknown:delivery_unknown",
    "webdev-old-queued:queued_stale",
  ],
);
assert.match(result.reason, /queued stale=2/);
assert.match(result.reason, /receipt unreconciled=1/);
assert.equal(DASHBOARD_EMAIL_CHECKS.length, 1);
assert.equal(DASHBOARD_EMAIL_CHECKS[0].id, "dashboard_email.queue_health");
assert.equal(DASHBOARD_EMAIL_CHECKS[0].lane, "operator", "OASIS queue pages CC's operator Telegram lane");
assert.deepEqual(DASHBOARD_EMAIL_CHECKS[0].rule, { kind: "must_be_zero" });

console.log("dashboard-email-health: all assertions passed");
