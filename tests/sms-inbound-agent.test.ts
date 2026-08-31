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
  releasePhoneSuppression,
  suppressPhoneNumber,
} from "../lib/sms-opt-out";
import {
  pendingTwilioCarrierAction,
  resolveTwilioInboundTenant,
  shouldHonorTwilioOptOut,
  TWILIO_SYNC_DB_OPERATION_BUDGET,
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
assert.equal(TWILIO_SYNC_DB_OPERATION_BUDGET, 13, "the synchronous webhook path has a fixed DB-operation ceiling");

const decodedStop = twilioMessageResponse(STOP_CONFIRMATION)
  .replace(/^<Response><Message>/, "")
  .replace(/<\/Message><\/Response>$/, "")
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">");
assert.equal(decodedStop, STOP_CONFIRMATION, "TwiML carries the carrier-approved copy byte-for-byte");
assert.equal(twilioMessageResponse(), "<Response/>");
assert(shouldHonorTwilioOptOut("please stop texting me"));
assert(!shouldHonorTwilioOptOut("stop by at 3"), "ordinary scheduling language must not suppress a lead");
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
assert.equal(
  pendingTwilioCarrierAction({ intent: "opt_out", proposed_action: "cancel_meeting", executed_action: null }),
  "stop",
);
assert.equal(
  pendingTwilioCarrierAction({ intent: "unknown", proposed_action: "release_suppression", executed_action: null }),
  "start",
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

const failingDb = {
  from(table: string) {
    return {
      select() { return this; },
      eq() { return this; },
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
const unmatchedFallback = await resolveTwilioInboundTenant(failingDb as never, "+18005550199", {
  TWILIO_TENANT_ID: "tenant-fallback",
});
assert.equal(unmatchedFallback, null, "an unmatched To number must never inherit the default tenant");
const matchedFallback = await resolveTwilioInboundTenant(failingDb as never, "+1 (800) 555-0199", {
  TWILIO_TENANT_ID: "tenant-fallback",
  TWILIO_FROM_NUMBER: "+18005550199",
});
assert.deepEqual(matchedFallback, { tenantId: "tenant-fallback", ownerUserId: null });

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
await raw.close();

const optOutSource = readFileSync("lib/sms-opt-out.ts", "utf8");
assert(!optOutSource.includes("child_process"));
const webhookSource = readFileSync("app/api/webhooks/twilio/sms-inbound/route.ts", "utf8");
assert.match(webhookSource, /sms_agent_jobs/);
assert.match(webhookSource, /provider_message_id/);
assert.match(webhookSource, /cancel_meeting/);
assert.match(webhookSource, /website_sales_meeting_notifications/);
assert.match(webhookSource, /opt_out_detected/);
assert(!webhookSource.includes("queueInfer"));
assert(!webhookSource.includes("sendSmsDirectTwilio"));
assert.match(webhookSource, /loadExistingJob/);
assert.match(webhookSource, /pendingTwilioCarrierAction/);
assert.match(webhookSource, /TWILIO_SYNC_DB_OPERATION_BUDGET/);
assert.match(webhookSource, /new SyncOperationBudget/);
assert.doesNotMatch(
  webhookSource,
  /isUniqueViolationError\(insertedJob\.error\)\) return xmlResponse\(\)/,
  "a duplicate delivery must reload and resume an incomplete carrier action",
);
for (const noncriticalCall of [
  "persistCanonicalLeadTouch",
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
assert.match(resolverSource, /\.order\("tenant_id"/);
assert.match(resolverSource, /\.limit\(MAX_TWILIO_CREDENTIAL_CANDIDATES \+ 1\)/);
assert.match(resolverSource, /TWILIO_FROM_NUMBER/);

console.log("sms-inbound-agent: OK");
}

void main();
