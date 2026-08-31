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
  resolveTwilioInboundTenant,
  shouldHonorTwilioOptOut,
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

const failingDb = {
  from(table: string) {
    return {
      select() { return this; },
      eq() { return this; },
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
const fallback = await resolveTwilioInboundTenant(failingDb as never, "+18005550199", {
  TWILIO_TENANT_ID: "tenant-fallback",
});
assert.deepEqual(fallback, { tenantId: "tenant-fallback", ownerUserId: null });

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

console.log("sms-inbound-agent: OK");
}

void main();
