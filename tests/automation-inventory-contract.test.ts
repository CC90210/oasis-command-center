/**
 * Regression contract for the 2026-09-16 operator inventory outage.
 *
 * Production returned a plausible 4/1 tenant-only list because a configured
 * legacy operator alias replaced CC's canonical address. These assertions pin
 * the auth union, complete-read behavior, tenant-scoped toggle readback/audit,
 * and the client rule that success follows persisted state rather than a 2xx.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOperatorEmail } from "../lib/operator-credentials";

const previousOperator = process.env.OPERATOR_EMAIL;
const previousAdmins = process.env.ADMIN_EMAILS;
try {
  process.env.OPERATOR_EMAIL = "legacy-operator@icloud.com";
  process.env.ADMIN_EMAILS = "another-admin@example.com";
  assert.equal(isOperatorEmail("conaugh@oasisai.work"), true, "canonical CC address cannot be shadowed");
  assert.equal(isOperatorEmail("legacy-operator@icloud.com"), true, "configured alias remains valid");
  assert.equal(isOperatorEmail("another-admin@example.com"), true, "admin aliases remain valid");
  assert.equal(isOperatorEmail("stranger@example.com"), false);
} finally {
  if (previousOperator === undefined) delete process.env.OPERATOR_EMAIL;
  else process.env.OPERATOR_EMAIL = previousOperator;
  if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = previousAdmins;
}

const listRoute = readFileSync("app/api/cron-jobs/route.ts", "utf8");
assert.match(listRoute, /owner_agent_key/, "GET must read durable Empire ownership");
assert.match(listRoute, /fail_count/, "GET must read unresolved Empire failure state");
assert.match(listRoute, /normalizeTenantCronRow/, "GET must return tenant enabled state as a boolean");
assert.match(
  listRoute,
  /if \(empireQuery\.error\)[\s\S]{0,500}status: 500/,
  "an Empire read failure must fail the inventory instead of returning tenant-only success",
);
assert.match(listRoute, /buildAutomationInventoryMetadata/,
  "GET must return a counted inventory receipt and reject duplicates/partial operator reads");
assert.match(listRoute, /inventory[^}]*\}/,
  "GET success must include inventory metadata alongside jobs");
assert.doesNotMatch(listRoute, /VALID_ACTION_TYPES[^\n]*agent_prompt/,
  "create API must not advertise agent_prompt until a runner supports it");
const patchRoute = readFileSync("app/api/cron-jobs/[id]/route.ts", "utf8");
assert.match(patchRoute, /body\.source/, "PATCH must dispatch the exact row source");
assert.match(patchRoute, /toggleCronWithAudit/, "toggles must use the atomic state+audit transaction");
assert.match(patchRoute, /toggleLegacyCronWithAudit/, "the supported legacy rollback must retain toggles");
assert.match(
  patchRoute,
  /process\.env\.EMPIRE_DATA_BACKEND === "turso_cloud"[\s\S]{0,100}tursoConfigured\(\)/,
  "toggle dispatch must mirror the inventory adapter's exact Turso condition",
);
assert.match(
  patchRoute,
  /backendMode === "turso"[\s\S]{0,200}toggleCronWithAudit[\s\S]{0,200}toggleLegacyCronWithAudit/,
  "Turso and Supabase inventory lanes must dispatch to their own atomic implementation",
);
assert.match(patchRoute, /normalizeEmpireRow/, "Empire PATCH must return the same normalized shape as GET");
assert.match(patchRoute, /normalizeTenantCronRow/, "tenant PATCH must return enabled state as a boolean");

const atomicToggle = readFileSync("lib/automations/cron-toggle-transaction.ts", "utf8");
assert.match(atomicToggle, /transaction\("write"\)/, "toggle must open a write transaction");
assert.ok(
  (atomicToggle.match(/tenant_id = \?/g) || []).length >= 3,
  "lookup, compare-and-set, and readback must all stay tenant-scoped",
);
assert.match(atomicToggle, /INSERT INTO tenant_audit_log/, "transaction must append the audit receipt");
assert.match(atomicToggle, /before[\s\S]{0,300}previousEnabled/, "audit must retain prior state");
assert.match(atomicToggle, /JSON\.stringify\(\{ source: input\.source, name, enabled: persistedEnabled \}\)/,
  "audit must retain persisted state");
assert.ok(
  atomicToggle.indexOf("INSERT INTO tenant_audit_log") < atomicToggle.indexOf("await tx.commit()"),
  "audit and scheduler state must commit together",
);

const legacyMigration = readFileSync("database/174_cron_owner_atomic_toggle.sql", "utf8");
assert.match(legacyMigration, /ADD COLUMN IF NOT EXISTS owner_agent_key text/);
assert.match(legacyMigration, /CREATE OR REPLACE FUNCTION public\.toggle_cron_job_with_audit_v1/);
assert.match(legacyMigration, /SECURITY DEFINER\r?\nSET search_path = public, pg_temp/);
assert.match(legacyMigration, /REVOKE ALL ON TABLE public\.cron_jobs FROM anon, authenticated/);
assert.doesNotMatch(legacyMigration, /\bRETURNING\b/i,
  "guarded exec_sql must not misclassify the migration as a result query");
assert.doesNotMatch(legacyMigration, /^\s*(BEGIN|COMMIT)\s*;/im,
  "exec_sql supplies the transaction and rejects nested transaction control");
assert.ok(
  legacyMigration.indexOf("SET owner_agent_key = 'atlas'") <
    legacyMigration.lastIndexOf("SET owner_agent_key = 'bravo'"),
  "legacy backfill must preserve recognizable Atlas rows before defaulting ownership",
);
assert.ok(
  legacyMigration.indexOf("SET owner_agent_key = 'aura'") <
    legacyMigration.lastIndexOf("SET owner_agent_key = 'bravo'"),
  "legacy backfill must preserve recognizable Aura rows before defaulting ownership",
);

const tursoMigration = readFileSync("database/turso/bravo__108_cron_owner_agent_key.sql", "utf8");
assert.match(tursoMigration, /ADD COLUMN "owner_agent_key" TEXT NOT NULL DEFAULT 'bravo'/,
  "a fresh Turso deployment must create the durable owner column");
assert.match(tursoMigration, /SET "owner_agent_key" = 'maven'/);
assert.match(tursoMigration, /idx_cron_jobs_tenant_owner_active/);
const tursoReconciliation = readFileSync(
  "database/turso/bravo__110_cron_owner_reconciliation.sql",
  "utf8",
);
assert.match(tursoReconciliation, /SET "owner_agent_key" = 'maven'/);
assert.match(tursoReconciliation, /SET "owner_agent_key" = 'atlas'/);
assert.match(tursoReconciliation, /SET "owner_agent_key" = 'aura'/);
assert.doesNotMatch(tursoReconciliation, /ALTER TABLE/,
  "owner corrections must move forward without editing the ledger-locked column migration");

const manager = readFileSync("components/automations/CronJobsManager.tsx", "utf8");
assert.match(manager, /JSON\.stringify\(\{ enabled: next, source: job\.source \}\)/);
assert.match(manager, /persisted[\s\S]{0,300}enabled[\s\S]{0,300}next/,
  "client success must validate the authoritative state");
assert.match(manager, /next_run_at/, "cards must carry and render the scheduler's next run");
assert.match(manager, /parseAutomationInventorySuccess/,
  "the client must runtime-validate jobs and inventory metadata before rendering");
assert.match(manager, /partitionCronJobsByOwner/,
  "owner groups must use the exact-owner partition helper");
assert.match(manager, /cronJobKey/,
  "row, edit, and pending identity must include source:id");
assert.match(manager, /Retry/, "load failures must provide an in-place retry");
assert.match(manager, /Last refreshed/, "operators must see when the inventory was last confirmed");
assert.match(manager, /Couldn't delete/, "delete failures must be visible to the operator");
assert.match(manager, /unresolved_failures/,
  "Empire failure counters must remain visibly red until a successful run clears them");
assert.doesNotMatch(manager, /agent_prompt/,
  "the create UI must not offer an action the runner cannot execute");
assert.match(manager, /isDaemonTransitionConfirmed/,
  "daemon controls must wait for an authoritative state+heartbeat readback");
assert.match(manager, /DAEMON_CONFIRM_TIMEOUT_MS = 75_000/,
  "daemon confirmation must stop waiting and fail visibly after about 75 seconds");
assert.match(manager, /last_ping_at: daemon\.last_ping_at/,
  "daemon control must capture the pre-action heartbeat baseline");
assert.match(manager, /while \(!controller\.signal\.aborted/,
  "daemon confirmation must poll without allowing an unmounted operation to win a race");
assert.doesNotMatch(manager, /Optimistic flip/,
  "command acceptance must never optimistically flip the displayed daemon state");
assert.doesNotMatch(manager, /setTimeout\(\(\) => \{ void refresh\(\); \}, 5_000\)/,
  "a single delayed refresh is not sufficient runtime confirmation");

const catalog = readFileSync("lib/agent-catalog.ts", "utf8");
assert.doesNotMatch(catalog, /name: "content_pipeline"[\s\S]{0,120}schedule: "0 9 \* \* \*"/);
assert.match(catalog, /name: "Maven — Carousel Post"/);
assert.match(catalog, /name: "Carousel Media Retention"/);

const agentsPage = readFileSync("app/agents/page.tsx", "utf8");
assert.match(agentsPage, /Registered schedules/);
assert.match(agentsPage, /status in Automations/);
assert.doesNotMatch(agentsPage, /what's running for it right now/);

console.log("automation-inventory-contract: all assertions passed");
