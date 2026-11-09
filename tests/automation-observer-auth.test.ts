import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { checkAutomationObserverAuth } from "../lib/automation-observer-auth";

process.env.CRON_SECRET = "synthetic-cron";
process.env.AUTOMATION_OBSERVER_ATTEST_SECRET = "synthetic-observer";
process.env.CRON_ATTEST_SECRET = "synthetic-business-cron";
process.env.CRON_ALLOW_LOCAL = "1";
const auth = (headers: Record<string, string>) => checkAutomationObserverAuth(new NextRequest("https://fixture.invalid/api/cron/automation-observer", { headers }));
assert.equal(auth({ authorization: "Bearer synthetic-cron", "x-oasis-observer-attest": "synthetic-observer" }), null);
for (const headers of [
  {}, { authorization: "Bearer synthetic-cron" }, { "x-oasis-observer-attest": "synthetic-observer" },
  { authorization: "Bearer synthetic-cron", "x-vercel-cron": "1" },
  { authorization: "Bearer synthetic-cron", "x-oasis-cron-attest": "synthetic-business-cron" },
  { authorization: "Bearer wrong", "x-oasis-observer-attest": "synthetic-observer" },
  { authorization: "Bearer synthetic-cron", "x-oasis-observer-attest": "wrong" },
]) assert.equal(auth(headers as Record<string, string>)?.status, 401);
delete process.env.AUTOMATION_OBSERVER_ATTEST_SECRET;
assert.equal(auth({ authorization: "Bearer synthetic-cron", "x-vercel-cron": "1" })?.status, 500);
process.env.AUTOMATION_OBSERVER_ATTEST_SECRET = "synthetic-observer";
delete process.env.CRON_SECRET;
assert.equal(auth({ "x-oasis-observer-attest": "synthetic-observer" })?.status, 500);
console.log("automation-observer-auth: OK (both dedicated secrets, no legacy/local/platform bypass)");
