/**
 * Regression contract for exact-machine automation delivery.
 *
 * The selected daemon pulls both the cron row and its reviewed source. The
 * browser must not push write_file through the tenant-level bridge proxy,
 * because that proxy can address a different paired computer.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const component = readFileSync(join(ROOT, "components", "automations", "DescribeAutomationFlow.tsx"), "utf8");
const saveRoute = readFileSync(join(ROOT, "app", "api", "automations", "save-draft", "route.ts"), "utf8");
const pollRoute = readFileSync(join(ROOT, "app", "api", "cron-jobs", "poll", "route.ts"), "utf8");

assert.doesNotMatch(component, /\/api\/bridge\/exec-tool|\bBRIDGE_CHAT_BASE\b|127\.0\.0\.1/);
assert.match(component, /will materialize/);
assert.match(component, /New automations land switched off/);

assert.match(saveRoute, /_automation_template_id:\s*templateId/);
assert.doesNotMatch(saveRoute, /_generated_script_content:\s*draft\.script_content/);
assert.match(saveRoute, /target_pairing_id:\s*pipeline\.target_pairing_id/);
assert.doesNotMatch(saveRoute, /client_should_post_to_bridge_write_file/);

assert.match(pollRoute, /job\.target_pairing_id\s*&&\s*job\.target_pairing_id\s*!==\s*bridge\.pairingId/);
assert.match(pollRoute, /target_pairing_mismatch/);
assert.match(pollRoute, /job\.owner_user_id\s*&&\s*job\.owner_user_id\s*!==\s*bridge\.userId/);

console.log("describe-automation-flow-bridge-proxy.test.ts: OK");
