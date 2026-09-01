import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildTwilioMessageForm,
  twilioCredentialsReady,
} from "../lib/sms-direct-twilio";

const base = {
  account_sid: "AC123",
  auth_token: "secret",
};

const messagingService = buildTwilioMessageForm(
  { ...base, from_number: "+14165550101", messaging_service_sid: "MG123" },
  { to: "+14165550102", body: "Hello" },
);
assert.equal(messagingService.get("MessagingServiceSid"), "MG123");
assert.equal(messagingService.has("From"), false, "Twilio rejects a request carrying both sender fields");

const fromNumber = buildTwilioMessageForm(
  { ...base, from_number: "+14165550101" },
  { to: "+14165550102", body: "Hello" },
);
assert.equal(fromNumber.get("From"), "+14165550101");
assert.equal(fromNumber.has("MessagingServiceSid"), false);

assert(twilioCredentialsReady({ ...base, messaging_service_sid: "MG123" }));
assert(twilioCredentialsReady({ ...base, from_number: "+14165550101" }));
assert(!twilioCredentialsReady(base));

const schema = readFileSync("lib/tenant-integration-schemas.ts", "utf8");
assert.match(schema, /key:\s*"messaging_service_sid"/);
const store = readFileSync("lib/tenant-integration-store.ts", "utf8");
assert.match(store, /messaging_service_sid:\s*"TWILIO_MESSAGING_SERVICE_SID"/);
const availability = readFileSync("lib/routing/provider-availability.ts", "utf8");
assert.match(availability, /\["account_sid",\s*"auth_token",\s*"messaging_service_sid"\]/);
const settings = readFileSync("components/settings/IntegrationKeysPanel.tsx", "utf8");
assert.match(settings, /schema\.service === "twilio"/);
assert.match(settings, /messaging_service_sid/);

console.log("sms-sender-messaging-service: OK");
