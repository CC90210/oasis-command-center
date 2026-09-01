import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  HELP_RESPONSE,
  SMS_CONSENT_DISCLOSURE,
  START_CONFIRMATION,
  STOP_CONFIRMATION,
} from "../lib/sms/auto-responses";
import { countSegments } from "../lib/sms-segments";
import {
  applyInboundSmsStop,
  isInvalidSuppressionPhoneError,
  normalizeInboundSmsPhone,
  releasePhoneSuppression,
  smsSuppressionFailureResponse,
  suppressPhoneNumber,
} from "../lib/sms-opt-out";
import {
  hasTwilioCarrierExecutedAction,
  pendingTwilioCarrierAction,
  resolveTwilioInboundTenant,
  shouldHonorTwilioOptOut,
  TWILIO_SYNC_DB_OPERATION_BUDGET,
  twilioCarrierReplyForDelivery,
  twilioInboundForbiddenResponse,
  twilioMessageResponse,
  verifyTwilioSignature,
} from "../lib/sms/twilio-inbound";

for (const copy of [STOP_CONFIRMATION, HELP_RESPONSE, START_CONFIRMATION, SMS_CONSENT_DISCLOSURE]) {
  assert.equal(countSegments(copy), 1, `carrier copy must fit one segment: ${copy}`);
  assert.match(copy, /OASIS AI Solutions/);
  assert.match(copy, /message frequency/i);
  assert.match(copy, /rates may apply/i);
  assert.match(copy, /STOP/i);
}

const url = "https://oasisai.work/api/webhooks/twilio/sms-inbound";
const params = new URLSearchParams({ Body: "STOP", From: "+14165550101", To: "+18005550199" });
const base = [...params.entries()]
  .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
  .reduce((value, [key, item]) => `${value}${key}${item}`, url);
const signature = createHmac("sha1", "auth-token").update(base, "utf8").digest("base64");
assert(verifyTwilioSignature(url, params, signature, "auth-token"));
assert(!verifyTwilioSignature(url, params, "wrong", "auth-token"));
assert.equal(TWILIO_SYNC_DB_OPERATION_BUDGET, 14, "the synchronous webhook path has a fixed DB-operation ceiling");

const decodedStop = twilioMessageResponse(STOP_CONFIRMATION)
  .replace(/^<Response><Message>/, "")
  .replace(/<\/Message><\/Response>$/, "")
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");
assert.equal(decodedStop, STOP_CONFIRMATION, "TwiML carries the carrier-approved copy byte-for-byte");
assert.equal(twilioMessageResponse(), "<Response/>");
assert.equal(normalizeInboundSmsPhone("+1 (416) 555-0101"), "+14165550101");
assert.equal(normalizeInboundSmsPhone("416-555-0101"), "+14165550101");
assert.equal(normalizeInboundSmsPhone("+44 20 7946 0958"), "+442079460958");
assert.equal(
  normalizeInboundSmsPhone("+47 912 34 567"),
  "+4791234567",
  "a plus-prefixed international E.164 number must not be reinterpreted as NANP",
);
assert.throws(
  () => normalizeInboundSmsPhone("91234567"),
  /invalid_suppression_phone/,
  "a short number without an explicit country code is ambiguous",
);
assert.throws(() => normalizeInboundSmsPhone("+0123456789"), /invalid_suppression_phone/);
assert(isInvalidSuppressionPhoneError(new Error("invalid_suppression_phone")));
assert(shouldHonorTwilioOptOut("please stop texting me"));
for (const explicitRevocation of [
  "stop now",
  "unsubscribe now",
  "please stop now",
  "quit now",
  "end now",
  "STOP 123",
  "STOP reschedule our meeting",
  "STOP, cancel our meeting",
  "cancel our meeting STOP",
  "reschedule our meeting unsubscribe",
  "Please cancel our important founder meeting STOP",
  "Please reschedule our important founder meeting and then STOP",
  "quit and cancel our meeting",
  "opt me out",
  "unsubscribe me",
  "withdraw my consent",
  "revoke consent",
  "do not send me SMS",
  "don't send texts",
]) {
  assert(
    shouldHonorTwilioOptOut(explicitRevocation),
    `shared explicit opt-out verdict must be honored inline: ${explicitRevocation}`,
  );
}
assert(!shouldHonorTwilioOptOut("stop by at 3"), "ordinary scheduling language must not suppress a lead");
assert(!shouldHonorTwilioOptOut("bus stop before our meeting"), "a middle-word transit stop is not an opt-out");
assert(!shouldHonorTwilioOptOut("can you cancel the second item"), "an item cancellation is not a global opt-out");
assert(!shouldHonorTwilioOptOut("cancel my meeting"), "a meeting-only cancellation is handled by the reply agent");
assert(!shouldHonorTwilioOptOut("please end our meeting"), "END used as a meeting verb is not a global opt-out");
assert(!shouldHonorTwilioOptOut("our subscription ends tomorrow"), "ordinary use of 'ends' is not a carrier opt-out token");
assert(!shouldHonorTwilioOptOut("please revoke the calendar invite"), "a long invite request is not consent revocation");
assert(
  !shouldHonorTwilioOptOut("Cancel my meeting and text me alternatives"),
  "meeting cancellation plus a request for a text reply is not a global opt-out",
);
assert(
  !shouldHonorTwilioOptOut("Please cancel the meeting; message me new times"),
  "meeting cancellation plus a request for new times is not a global opt-out",
);
assert(shouldHonorTwilioOptOut("Cancel my meeting and STOP"), "an explicit STOP still wins the scheduling carve-out");
assert(shouldHonorTwilioOptOut("Cancel my appointment and don't text me"));
for (const revocation of [
  "Cancel my appointment and remove me please",
  "Please cancel my meeting and cancel all texts",
  "Cancel my appointment and STOP ALL",
  "cancel my meeting and stop texting me",
]) {
  assert(shouldHonorTwilioOptOut(revocation), `global revocation must win meeting language: ${revocation}`);
}
assert.equal(
  pendingTwilioCarrierAction({ intent: "opt_out", proposed_action: "cancel_meeting", executed_action: null }),
  "stop",
);
assert.equal(
  pendingTwilioCarrierAction({ intent: "unknown", proposed_action: "release_suppression", executed_action: null }),
  "start",
);
assert.equal(
  pendingTwilioCarrierAction({ intent: "question", proposed_action: "reply_help", executed_action: null }),
  "help",
  "HELP stays resumable until the interaction and canonical touch are durable",
);
assert.equal(
  pendingTwilioCarrierAction({
    intent: "unknown",
    proposed_action: "release_suppression",
    executed_action: "release_suppression",
  }),
  null,
  "a completed carrier action is not repeated on a normal retry",
);
assert(
  hasTwilioCarrierExecutedAction(
    "suppress_and_cancel_sms,cancel_meeting,reply_suppressed_for_stop",
    "suppress_and_cancel_sms",
  ),
);
assert.equal(
  pendingTwilioCarrierAction({
    intent: "opt_out",
    proposed_action: "cancel_meeting",
    executed_action: "suppress_and_cancel_sms,cancel_meeting,reply_suppressed_for_stop",
  }),
  null,
  "worker action ledger entries after STOP must not replay carrier compliance",
);
assert.equal(
  pendingTwilioCarrierAction({
    intent: "question",
    proposed_action: "reply_help",
    executed_action: "reply_help,worker_observed",
  }),
  null,
  "HELP completion is token-based when later actions are appended",
);
const completedStop = {
  intent: "opt_out",
  proposed_action: "cancel_meeting",
  executed_action: "suppress_and_cancel_sms",
};
assert.equal(
  twilioCarrierReplyForDelivery(completedStop, { duplicate: true, resumedAction: null }),
  null,
  "a completed STOP retry is acknowledged with empty TwiML",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "question", proposed_action: "reply_help", executed_action: "reply_help" },
    { duplicate: true, resumedAction: null },
  ),
  null,
  "a completed HELP retry is acknowledged with empty TwiML",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "unknown", proposed_action: "release_suppression", executed_action: "release_suppression" },
    { duplicate: true, resumedAction: null },
  ),
  null,
  "a completed START retry is acknowledged with empty TwiML",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "question", proposed_action: "reply_help", executed_action: "reply_help" },
    { duplicate: false, resumedAction: null },
  ),
  "help",
  "the first HELP delivery still receives its inline reply",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "opt_out", proposed_action: "cancel_meeting", executed_action: null },
    { duplicate: true, resumedAction: "stop" },
  ),
  "stop",
  "an incomplete STOP retry resumes and receives the confirmation",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "unknown", proposed_action: "release_suppression", executed_action: null },
    { duplicate: true, resumedAction: "start" },
  ),
  "start",
  "an incomplete START retry resumes and receives the confirmation",
);
assert.equal(
  twilioCarrierReplyForDelivery(
    { intent: "question", proposed_action: "reply_help", executed_action: null },
    { duplicate: true, resumedAction: "help" },
  ),
  "help",
  "an incomplete HELP retry resumes and receives the reply",
);

const failingDb = {
  from(table: string) {
    return {
      select() { return this; },
      eq() { return this; },
      in() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async () => ({
        data: null,
        error: table === "channel_accounts" ? { message: "no such table" } : { message: "credential read failed" },
      }),
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve({ data: null, error: { message: "credential read failed" } }).then(resolve);
      },
    };
  },
};
async function main() {
const invalidSuppressionFailure = smsSuppressionFailureResponse(new Error("invalid_suppression_phone"));
assert.deepEqual(invalidSuppressionFailure, { error: "invalid_suppression_phone", status: 400 });
assert.deepEqual(
  smsSuppressionFailureResponse(new Error("suppression_write_failed:database unavailable")),
  { error: "suppression_failed", status: 503 },
);
const forbidden = twilioInboundForbiddenResponse();
assert.equal(forbidden.status, 403);
assert.equal(await forbidden.text(), "Forbidden");

const unmatchedFallback = await resolveTwilioInboundTenant(failingDb as never, "+18005550199", {
  TWILIO_TENANT_ID: "tenant-fallback",
});
assert.equal(unmatchedFallback, null, "an unmatched To number must never inherit the default tenant");
const matchedFallback = await resolveTwilioInboundTenant(failingDb as never, "+1 (800) 555-0199", {
  TWILIO_TENANT_ID: "tenant-fallback",
  TWILIO_FROM_NUMBER: "+18005550199",
});
assert.deepEqual(matchedFallback, { tenantId: "tenant-fallback", ownerUserId: null });

process.env.BRAVO_FIELD_ENCRYPTION_KEY = "sms-inbound-agent-test-key-material";
const { encryptField } = await import("../lib/field-encryption");
const messagingServiceCredentialDb = {
  from(table: string) {
    return {
      select() { return this; },
      eq() { return this; },
      in() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async () => ({ data: null, error: null }),
      then(resolve: (value: unknown) => unknown) {
        const result = table === "tenant_integration_credentials"
          ? {
              data: [{
                tenant_id: "tenant-messaging-service",
                field_key: "messaging_service_sid",
                encrypted_value: encryptField("MG11111111111111111111111111111111"),
              }],
              error: null,
            }
          : { data: null, error: null };
        return Promise.resolve(result).then(resolve);
      },
    };
  },
};
const messagingServiceTenant = await resolveTwilioInboundTenant(
  messagingServiceCredentialDb as never,
  "+18005550199",
  {},
  undefined,
  "MG11111111111111111111111111111111",
);
assert.deepEqual(
  messagingServiceTenant,
  { tenantId: "tenant-messaging-service", ownerUserId: null },
  "a Messaging Service-only tenant must still receive compliance-critical inbound replies",
);

const raw = createClient({ url: ":memory:" });
await raw.executeMultiple(`
  CREATE TABLE sunbiz_phone_suppressions (
    tenant_id TEXT NOT NULL,
    phone_last10 TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    source_work_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id, phone_last10)
  );
  CREATE TABLE lead_interactions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL,
    lead_id TEXT,
    type TEXT,
    channel TEXT,
    direction TEXT,
    agent_source TEXT,
    from_phone TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE website_sales_meeting_notifications (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,
    claimed_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
`);
const db = createTursoPostgrest(raw);
await suppressPhoneNumber(db as never, {
  tenantId: "tenant-a",
  phone: "+1 (416) 555-0101",
  reason: "OPT_OUT",
  source: "twilio_webhook",
});
assert.equal((await raw.execute("SELECT count(*) AS n FROM sunbiz_phone_suppressions")).rows[0].n, 1);
await releasePhoneSuppression(db as never, {
  tenantId: "tenant-a",
  phone: "+14165550101",
  source: "twilio_webhook",
});
assert.equal((await raw.execute("SELECT count(*) AS n FROM sunbiz_phone_suppressions")).rows[0].n, 0);
const restored = await raw.execute("SELECT metadata FROM lead_interactions");
assert.match(String(restored.rows[0].metadata), /opt_in_restored/);
await raw.execute({
  sql: `INSERT INTO sunbiz_phone_suppressions
    (tenant_id, phone_last10, reason, source) VALUES (?, ?, ?, ?)`,
  args: ["tenant-a", "6475550102", "MANUAL_BLOCK", "operator"],
});
await releasePhoneSuppression(db as never, {
  tenantId: "tenant-a",
  phone: "+16475550102",
  source: "twilio_webhook",
});
assert.equal(
  (await raw.execute("SELECT count(*) AS n FROM sunbiz_phone_suppressions WHERE phone_last10 = '6475550102'"))
    .rows[0].n,
  1,
  "START must not clear a non-opt-out suppression",
);
await assert.rejects(
  suppressPhoneNumber(db as never, {
    tenantId: "tenant-a",
    phone: "not-a-phone",
    reason: "OPT_OUT",
    source: "texttorrent_webhook",
  }),
  /invalid_suppression_phone/,
);
await raw.batch([
  {
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, channel, recipient, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ["sms-pending", "tenant-a", "sms", "+19055550103", "pending", "2026-09-01T14:00:00.000Z"],
  },
  {
    sql: `INSERT INTO website_sales_meeting_notifications
      (id, tenant_id, channel, recipient, status, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: ["email-pending", "tenant-a", "email", "+19055550103", "pending", "2026-09-01T14:00:00.000Z"],
  },
]);
await applyInboundSmsStop(db as never, {
  tenantId: "tenant-a",
  phone: "+1 (905) 555-0103",
  receivedAt: "2026-09-01T14:05:00.000Z",
  source: "twilio_webhook",
});
const stoppedRows = await raw.execute(
  "SELECT id,status,last_error FROM website_sales_meeting_notifications ORDER BY id",
);
assert.deepEqual(
  stoppedRows.rows.map((row) => ({ id: row.id, status: row.status, last_error: row.last_error })),
  [
    { id: "email-pending", status: "pending", last_error: null },
    { id: "sms-pending", status: "cancelled", last_error: "recipient_opted_out" },
  ],
  "a formatted inbound STOP cancels only the canonical pending SMS recipient",
);
await raw.close();

const optOutSource = readFileSync("lib/sms-opt-out.ts", "utf8");
assert(!optOutSource.includes("child_process"));
const webhookSource = readFileSync("app/api/webhooks/twilio/sms-inbound/route.ts", "utf8");
const webhookPostSource = webhookSource.slice(webhookSource.indexOf("export async function POST"));
const textTorrentWebhookSource = readFileSync("app/api/webhooks/texttorrent/sms-inbound/route.ts", "utf8");
assert.match(webhookSource, /sms_agent_jobs/);
assert.match(webhookSource, /provider_message_id/);
assert.match(webhookSource, /cancel_meeting/);
assert.match(optOutSource, /website_sales_meeting_notifications/);
assert.match(webhookSource, /opt_out_detected/);
assert(!webhookSource.includes("queueInfer"));
assert(!webhookSource.includes("sendSmsDirectTwilio"));
assert.match(webhookSource, /loadExistingJob/);
assert.match(webhookSource, /pendingTwilioCarrierAction/);
assert.match(webhookSource, /select\("status,executed_action"\)/);
assert.match(webhookSource, /current\.executed_action[\s\S]*?update\.eq\("executed_action", current\.executed_action\)/);
assert.match(webhookSource, /deliveryWasDuplicate/);
assert.match(webhookSource, /twilioCarrierReplyForDelivery/);
assert.match(webhookSource, /const carrierReply = twilioCarrierReplyForDelivery/);
assert.doesNotMatch(webhookSource, /if \(job\.intent === "opt_out"\) return xmlResponse/);
assert.match(webhookSource, /await persistCanonicalLeadTouch\(db, \{ tenantId, leadId: job\.lead_id, occurredAt: job\.received_at \}\)/);
assert.match(webhookSource, /runStopComplianceEffects/);
assert.match(webhookSource, /params\.get\("MessagingServiceSid"\)/);
assert.match(webhookSource, /normalizedFrom = normalizeInboundSmsPhone\(from\)/);
assert.match(webhookSource, /from_phone: normalizedFrom/);
assert.match(webhookSource, /await applyInboundSmsStop\(db,/);
const unresolvedStart = webhookSource.indexOf("if (!resolved)");
const resolvedBindingStart = webhookSource.indexOf("const { tenantId, ownerUserId }", unresolvedStart);
assert(unresolvedStart >= 0 && resolvedBindingStart > unresolvedStart, "the unmapped Twilio branch must be locatable");
const unresolvedBranch = webhookSource.slice(unresolvedStart, resolvedBindingStart);
assert.match(unresolvedBranch, /return twilioInboundForbiddenResponse\(\)/);
assert.doesNotMatch(unresolvedBranch, /422|Unmapped destination/);
const suppressionCall = textTorrentWebhookSource.indexOf("await suppressPhoneNumber(db");
const suppressionCatch = textTorrentWebhookSource.indexOf("} catch (error) {", suppressionCall);
const leadLookup = textTorrentWebhookSource.indexOf("let leadId", suppressionCatch);
assert(suppressionCall >= 0 && suppressionCatch > suppressionCall && leadLookup > suppressionCatch);
const suppressionCatchBranch = textTorrentWebhookSource.slice(suppressionCatch, leadLookup);
assert.match(suppressionCatchBranch, /const failure = smsSuppressionFailureResponse\(error\)/);
assert.match(suppressionCatchBranch, /status: failure\.status/);
assert.doesNotMatch(suppressionCatchBranch, /status: 503/);
const stopEffectsIndex = webhookPostSource.indexOf("await runStopComplianceEffects");
const canonicalTouchIndex = webhookPostSource.indexOf("await persistCanonicalLeadTouch");
const stopMarkIndex = webhookPostSource.indexOf(
  'await markCarrierAction(db, tenantId, job.id, "suppress_and_cancel_sms"',
);
assert(
  stopEffectsIndex >= 0 && canonicalTouchIndex >= 0 && stopMarkIndex >= 0,
  "STOP ordering anchors must all exist before their order is compared",
);
assert(
  stopEffectsIndex < canonicalTouchIndex,
  "STOP suppression and outbox cancellation must precede canonical touch",
);
assert(
  canonicalTouchIndex < stopMarkIndex,
  "STOP remains incomplete until canonical touch succeeds",
);
assert.doesNotMatch(webhookSource, /status: keyword === "help" \? "done" : "pending"/);
assert.doesNotMatch(webhookSource, /executed_action: keyword === "help" \? "reply_help" : null/);
assert.match(webhookSource, /TWILIO_SYNC_DB_OPERATION_BUDGET/);
assert.match(webhookSource, /new SyncOperationBudget/);
assert.doesNotMatch(
  webhookSource,
  /isUniqueViolationError\(insertedJob\.error\)\) return xmlResponse\(\)/,
  "a duplicate delivery must reload and resume an incomplete carrier action",
);
for (const noncriticalCall of [
  "writeAgentAlert",
  "nudgeConversations",
]) {
  assert(!webhookSource.includes(noncriticalCall), `${noncriticalCall} must be deferred to the durable worker`);
}
assert.match(webhookSource, /ensureInboundInteraction/);
assert.match(webhookSource, /interaction_id,intent,proposed_action,executed_action,received_at/);
assert.match(webhookSource, /receivedAt: job\.received_at/);
assert(
  webhookSource.indexOf("await ensureInboundInteraction") < webhookSource.indexOf("await runPendingCarrierAction"),
  "the durable interaction must exist before carrier effects and acknowledgement",
);
const resolverSource = readFileSync("lib/sms/twilio-inbound.ts", "utf8");
assert.match(resolverSource, /MAX_TWILIO_CREDENTIAL_CANDIDATES/);
assert.match(resolverSource, /const credentialFields = targetMessagingService/);
assert.match(resolverSource, /\.in\("field_key", credentialFields\)/);
assert.match(resolverSource, /\.order\("tenant_id"/);
assert.match(resolverSource, /\.limit\(MAX_TWILIO_CREDENTIAL_CANDIDATES \* credentialFields\.length \+ 1\)/);
assert.match(resolverSource, /TWILIO_FROM_NUMBER/);
assert.match(resolverSource, /TWILIO_MESSAGING_SERVICE_SID/);

console.log("sms-inbound-agent: OK");
}

void main();
