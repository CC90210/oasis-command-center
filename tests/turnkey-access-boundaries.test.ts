import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");
const includesAll = (path: string, needles: string[]) => {
  const code = source(path);
  for (const needle of needles) {
    assert.ok(code.includes(needle), `${path} must enforce ${needle}`);
  }
};

const sharedPolicy = source("lib/shared-tenant-resource-access.ts");
assert.ok(sharedPolicy.includes('if (!(tenantSlug || "").trim()) return false;'));
assert.ok(
  sharedPolicy.includes("return !isOasisSurfaceTenant(tenantSlug) || isAdmin;"),
  "OASIS shared tenant resources require canonical admin capability",
);

for (const path of [
  "app/api/gmail-templates/route.ts",
  "app/api/gmail-templates/[id]/route.ts",
  "app/api/gmail-templates/[id]/solara/route.ts",
  "app/api/renewals/route.ts",
  "app/api/renewals/[id]/route.ts",
  "app/api/renewals/[id]/outreach/route.ts",
  "app/api/drip-templates/route.ts",
  "app/api/esign/envelopes/route.ts",
  "app/api/esign/envelopes/[id]/route.ts",
  "app/api/esign/envelopes/[id]/send/route.ts",
  "app/api/esign/envelopes/[id]/remind/route.ts",
  "app/api/agent-alerts/[id]/resolve/route.ts",
  "app/api/notify/telegram-identity/route.ts",
  "app/api/integrations/keys/route.ts",
  "app/api/integrations/keys/test/route.ts",
  "app/api/integrations/constant-contact/status/route.ts",
  "app/api/devices/route.ts",
  "app/api/auth/pair-code/route.ts",
  "app/api/agent-config/test-connection/route.ts",
]) {
  includesAll(path, ["canAccessSharedTenantResource"]);
}

for (const path of [
  "app/api/credentials/custom/route.ts",
  "app/api/tenant/logo/route.ts",
  "app/api/tenant/agents/toggle/route.ts",
  "app/api/integrations/kixie/sync-webhooks/route.ts",
]) {
  includesAll(path, ["resolveSessionContext", ".isAdmin"]);
}

includesAll("lib/lead-document-access.ts", [
  "getReadableLeadTargetForSession",
  "!doc.lead_id && !session.isAdmin",
]);
includesAll("app/api/lead-documents/[id]/watermark-variant/route.ts", [
  "getWritableLead",
  '.select("entity_type")',
  'parentEntity !== "lead" && parentEntity !== "application"',
  "entity: parentEntity",
]);
includesAll("app/api/lead-documents/legacy-baked/route.ts", ["resolveSessionContext", "!sess.isAdmin"]);
includesAll("app/api/leads/missing-docs/route.ts", [
  "resolveLeadReadPolicy",
  "canReadLeadRecordWithPolicy",
]);
includesAll("app/api/leads/powerlist/route.ts", [
  "resolveSessionContext",
  "canMutateGenericLeadForTenant",
]);
includesAll("app/api/leads/quick-add/route.ts", [
  "canMutateGenericLeadForTenant",
  "lead_not_found",
  "assigned_to: sess.userId",
]);
includesAll("app/api/applications/[id]/edit/route.ts", ["canMutateGenericLeadForTenant"]);
includesAll("app/api/leads/[id]/collaborators/route.ts", [
  "canMutateGenericLeadForTenant",
  "!sess.isAdmin",
]);
includesAll("app/api/sequences/[id]/enroll/route.ts", ["getWritableLead"]);

includesAll("app/api/conversations/threads/[key]/route.ts", [
  "getReadableLeadTargetForSession",
  "getWritableLead",
]);
includesAll("app/api/conversations/summarize/route.ts", ["getReadableLeadTargetForSession"]);
includesAll("app/api/conversations/schedule/route.ts", [
  "lead_required",
  "getWritableLead",
  "thread_lead_mismatch",
  "recipient_lead_mismatch",
  "row.actor_user_id !== session.userId",
]);
includesAll("app/api/conversations/schedule-call/route.ts", [
  "lead_required",
  "getWritableLead",
  "row.actor_user_id !== session.userId",
]);
includesAll("app/api/conversations/scheduled-calls/route.ts", [
  '.eq("actor_user_id", session.userId)',
  "canMutateGenericLeadForTenant",
  "getWritableLead",
]);

console.log("turnkey-access-boundaries: OK");
