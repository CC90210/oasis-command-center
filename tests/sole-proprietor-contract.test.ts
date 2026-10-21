import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  LEGAL_ENTITY,
  LEGAL_OWNER_NAME,
  LEGAL_OWNERSHIP_STRUCTURE,
} from "../lib/legal/constants";
import {
  OASIS_PIPELINE_ASSIGNMENT_EMAILS,
  isOasisPipelineAssignmentMember,
} from "../lib/team";
import {
  FINANCE_OWNER_EMAILS,
  ownerKeyForEmail,
} from "../lib/founders-finances/access";

assert.equal(LEGAL_ENTITY, "OASIS AI Solutions");
assert.equal(LEGAL_OWNER_NAME, "Conaugh McKenna");
assert.equal(LEGAL_OWNERSHIP_STRUCTURE, "sole proprietorship");

assert.deepEqual(
  OASIS_PIPELINE_ASSIGNMENT_EMAILS,
  ["conaugh@oasisai.work"],
  "only CC is a standing OASIS pipeline owner",
);
assert.equal(isOasisPipelineAssignmentMember({ email: "adon@oasisai.work" }), false);

assert.deepEqual(
  FINANCE_OWNER_EMAILS,
  { cc: "conaugh@oasisai.work" },
  "only CC may resolve as a live OASIS finance owner",
);
assert.equal(ownerKeyForEmail("adon@oasisai.work"), null);

const about = readFileSync("app/(marketing)/about/page.tsx", "utf8");
assert.match(about, /LEGAL_OWNER_NAME/);
assert.match(about, /LEGAL_OWNERSHIP_STRUCTURE/);

const team = readFileSync("app/team/page.tsx", "utf8");
assert.match(team, /Sole proprietor/);
assert.match(team, /LEGAL_OWNER_NAME/);

const workers = readFileSync("lib/automations/oasis-workers.ts", "utf8");
assert.doesNotMatch(workers, /pm2\.bravo-coord/);
assert.doesNotMatch(workers, /\bAPEX\b/);

const sunbizWorkers = readFileSync("lib/automations/sunbiz-workers.ts", "utf8");
for (const service of ["pm2.mca-lead-scrubber", "pm2.ezra-telegram-bridge", "pm2.uw-lead-enricher"]) {
  const at = sunbizWorkers.indexOf(`service: "${service}"`);
  assert.ok(at >= 0, `${service} remains visible as retired history`);
  assert.match(sunbizWorkers.slice(at, at + 600), /archived_on: "2026-10-21"/, `${service} must be retired`);
}
const workerControl = readFileSync("app/api/automations/background-workers/control/route.ts", "utf8");
assert.match(workerControl, /if \(worker\.archived_on\)/, "retired former-operator workers cannot be restarted");

const telegram = readFileSync("lib/notify/telegram.ts", "utf8");
assert.doesNotMatch(telegram, /OASIS_SALES_TELEGRAM_(?:BOT_TOKEN|CHAT_ID)/);
assert.match(
  telegram,
  /sales:\s*\{[\s\S]*?tokenKeys:\s*\["OASIS_TELEGRAM_BOT_TOKEN"\][\s\S]*?chatKeys:\s*\["OASIS_TELEGRAM_CHAT_ID"\]/,
  "sales alerts must fail closed on CC's dedicated OASIS Telegram credentials",
);

const pgBridge = readFileSync("app/api/pg/rest/v1/[...path]/route.ts", "utf8");
assert.doesNotMatch(
  pgBridge,
  /APEX_PG_BRIDGE_TOKEN/,
  "the retired APEX credential must not authorize the production bridge",
);
const deployWorkflow = readFileSync(".github/workflows/deploy-cloudflare.yml", "utf8");
assert.doesNotMatch(
  deployWorkflow,
  /APEX_PG_BRIDGE_TOKEN|OASIS_SALES_TELEGRAM_(?:BOT_TOKEN|CHAT_ID)/,
  "deployment must not re-inject retired bridge or shared-sales credentials",
);

const revocation = readFileSync(
  "database/turso/bravo__235_revoke_former_oasis_operator.sql",
  "utf8",
);
assert.match(revocation, /UPDATE platform_operators/i);
assert.match(revocation, /67036c9a-de2e-47cd-89bd-af19004585b1/);
assert.match(revocation, /revoked_at\s+IS\s+NULL/i);
assert.match(revocation, /UPDATE booking_settings/i);
assert.match(revocation, /json_each\(booking_settings\.doc, '\$\.hosts'\)/i);
assert.doesNotMatch(revocation, /\$\.hosts\[\d+\]/, "booking-host removal must not depend on array position");

const pairingRevocation = readFileSync(
  "database/turso/bravo__236_close_former_oasis_access.sql",
  "utf8",
);
assert.match(pairingRevocation, /UPDATE _supabase_auth_users/i);
assert.match(pairingRevocation, /session_version\s*=\s*session_version\s*\+\s*1/i);
assert.match(pairingRevocation, /UPDATE bridge_pairings/i);
assert.match(pairingRevocation, /tenant_id\s*=\s*'ef8d389e-3f15-43f2-ae00-3660f69a1452'/i);
assert.match(pairingRevocation, /user_id\s*=\s*'67036c9a-de2e-47cd-89bd-af19004585b1'/i);
assert.match(pairingRevocation, /revoked_at\s+IS\s+NULL/i);
assert.match(pairingRevocation, /claim_enabled_at\s*=\s*NULL/i);
assert.match(pairingRevocation, /claim_capacity\s*=\s*0/i);
assert.match(pairingRevocation, /UPDATE bridge_pair_codes/i);
assert.match(pairingRevocation, /UPDATE tenant_invites/i);
assert.match(pairingRevocation, /UPDATE agent_model_config/i);
assert.match(pairingRevocation, /encrypted_api_key\s*=\s*NULL/i);

for (const path of [
  "app/api/import/[entity]/route.ts",
  "app/api/leads/import/route.ts",
  "app/api/leads/bulk/route.ts",
  "app/api/leads/quick-add/route.ts",
  "app/api/leads/[id]/assign/route.ts",
  "app/api/manifest/[slug]/cold-leads/[id]/promote/route.ts",
  "app/api/manifest/[slug]/records/[entity]/route.ts",
  "app/api/web-leads/claim/route.ts",
  "app/api/web-leads/assignable-reps/route.ts",
  "app/api/bridge/records/[entity]/route.ts",
  "app/pipeline/new/page.tsx",
  "components/import/ImportWizard.tsx",
]) {
  const source = readFileSync(path, "utf8");
  assert.doesNotMatch(source, /CC\s*(?:\+|or|and|,)\s*Adon/i, `${path} carries retired-owner copy`);
}

console.log("sole-proprietor-contract: all passed");
