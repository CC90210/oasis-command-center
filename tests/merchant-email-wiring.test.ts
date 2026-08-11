import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const handoff = read("lib/forms/next-steps-email.ts");
const submit = read("app/api/forms/submit/route.ts");
const manual = read("app/api/leads/[id]/email/route.ts");
const smtp = read("lib/integrations/submissions-gmail-send.ts");

assert.match(
  handoff,
  /input\.brand === "sunbiz"[\s\S]*?sendGmail\(\{[\s\S]*?tenantId: input\.tenantId,[\s\S]*?brand: "sunbiz"[\s\S]*?cc: input\.cc \? \[input\.cc\][\s\S]*?SUNBIZ_LEGAL_FOOTER[\s\S]*?listUnsubscribeHeader/,
  "form emails must use the tenant app-password SMTP sender and CC the assigned agent",
);
assert.match(
  handoff,
  /provider_message_id: reservationKey[\s\S]*?code === "23505"[\s\S]*?if \(direct\.ok\)[\s\S]*?agent_source: input\.source[\s\S]*?sent_via: "submissions_gmail_apppassword"/,
  "successful direct form sends must be recorded for audit and idempotency",
);
assert.match(handoff, /ageMs > 5 \* 60 \* 1000[\s\S]*?contains\("metadata", \{ status: "sending" \}\)[\s\S]*?released\.data\?\.length[\s\S]*?recoveryAttempt: true/,
  "stale in-progress reservations must be recoverable");
assert.match(handoff, /r\.agent_source !== "form_send_reservation"/,
  "temporary reservations must not bypass stale-reservation recovery");
assert.match(handoff, /retryTransient: false/,
  "form sends must fall back promptly instead of sleeping in a request worker");
assert.match(manual, /retryTransient: false/,
  "manual merchant sends must fall back promptly instead of sleeping in the API request");
assert.match(smtp, /payload\.retryTransient !== false/,
  "the shared SMTP sender must support no-delay request-bound delivery");
assert.match(
  handoff,
  /tenant\.slug === "bluerise"[\s\S]*?"bluerise"/,
  "non-SunBiz brands must retain their own credential routing",
);
assert.match(
  submit,
  /fullApplicationCollectsDocuments[\s\S]*?maybeSendApplicationReceivedEmail\(/,
  "the modern full application must schedule a merchant receipt",
);
assert.match(
  handoff,
  /APPLICATION_RECEIVED_SOURCE[\s\S]*?alreadySent\([\s\S]*?APPLICATION_RECEIVED_SOURCE/,
  "application receipts must be idempotent",
);
assert.match(
  manual,
  /brand === "sunbiz"[\s\S]*?sendGmail\(\{[\s\S]*?tenantId: sess\.tenantId[\s\S]*?brand: "sunbiz"/,
  "manual SunBiz merchant email must fall back directly to the shared app-password mailbox",
);
assert.match(
  smtp,
  /getSubmissionsCreds\(payload\.tenantId, payload\.brand\)/,
  "all shared sends must resolve the encrypted per-tenant app password",
);

console.log("merchant email wiring tests passed");
