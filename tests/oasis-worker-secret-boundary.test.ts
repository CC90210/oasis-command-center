import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");

// These bindings belong to the separated tenant runtime, never the OASIS
// Worker. This checks both the documented list and the actual build env because
// a NEXT_PUBLIC key in either place can be inlined into the browser bundle.
const SEPARATED_TENANT_BINDINGS = [
  "DRIPS_EMAIL_DAILY_CAP_SUNBIZ",
  "NEXT_PUBLIC_OPTINVAULT_DISCLOSURE_SUNBIZ",
  "NEXT_PUBLIC_OPTINVAULT_SITE_KEY_SUNBIZ",
  "SUNBIZ_OPS_TELEGRAM_BOT_TOKEN",
  "SUNBIZ_OPS_TELEGRAM_CHAT_ID",
  "SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID",
  "SUNBIZ_PUBLIC_FORM_ORIGIN",
];

for (const key of SEPARATED_TENANT_BINDINGS) {
  assert.ok(!workflow.includes(key), `${key} must never enter the OASIS Worker build`);
}

assert.match(workflow, /--var DEPLOY_ENV:production/);
assert.match(workflow, /--var DEPLOY_GIT_REF:\$\{\{ github\.ref_name \}\}/);
assert.match(workflow, /--var DEPLOY_GIT_SHA:\$\{\{ github\.sha \}\}/);

console.log("OASIS Worker secret boundary ok");
