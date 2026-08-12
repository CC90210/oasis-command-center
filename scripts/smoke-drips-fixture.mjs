/**
 * scripts/smoke-drips-fixture.mjs — set up / tear down an ISOLATED sequence for
 * smoke-testing the Drips surfaces against production.
 *
 * WHY A FIXTURE AND NOT A LIVE SEQUENCE. Drips are live (DRIPS_LIVE=1) and 8 of
 * the 11 sequences are enabled. Toggling one on, repinning its template, or
 * setting a cap of 0 on it changes what real merchants receive within minutes.
 * So every WRITE test runs against a sequence that cannot reach anybody:
 *
 *   - trigger stage `apex_smoke_test`, which no lead has ever been in, so the
 *     enroller can never match it;
 *   - disabled by default, enabled only inside the toggle test;
 *   - pool templates seeded ONLY under that same stage, so they can never be
 *     selected for a live sequence. This matters more than it looks: resolveCopy
 *     prefers an approved pool entry over the step's own copy, so seeding
 *     (sunbiz, follow_up, nudge) would silently change live merchant mail on the
 *     next dispatch.
 *
 * Usage:
 *   node scripts/smoke-drips-fixture.mjs setup
 *   node scripts/smoke-drips-fixture.mjs teardown
 *   node scripts/smoke-drips-fixture.mjs show
 */

import { execFileSync } from "node:child_process";

const DB = "bravo-empire";
const TURSO = "C:/Users/echel/JARVIS/scripts/turso_sql.mjs";
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

export const SEQ_ID = "a9e5f000-5m0k-4e00-0000-000000000001".replace("m0k", "b0c");
export const STAGE = "apex_smoke_test";
export const TPL_A = "a9e5f000-0000-4e00-0000-0000000000aa";
export const TPL_B = "a9e5f000-0000-4e00-0000-0000000000bb";
export const TPL_OPENER = "a9e5f000-0000-4e00-0000-0000000000cc";
export const TPL_RETIRED = "a9e5f000-0000-4e00-0000-0000000000dd";

/** argv array, never a shell string — the values below are literals today, but
 *  the rule does not bend for convenience. */
function sql(query, write = false) {
  const args = [TURSO, "--db", DB];
  if (write) args.push("--write");
  args.push("--sql", query);
  const out = execFileSync("node", args, { encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const rows = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* trailing count line */
      }
    }
  }
  return rows;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const STEPS = JSON.stringify([
  {
    channel: "email",
    delay_minutes: 0,
    subject: "SMOKE TEST step 1 subject",
    body: "SMOKE TEST step 1 body. This sequence is a test fixture and can reach nobody.",
    role: "nudge",
  },
  {
    channel: "email",
    delay_minutes: 1440,
    subject: "SMOKE TEST step 2 subject",
    body: "SMOKE TEST step 2 body. This sequence is a test fixture and can reach nobody.",
    role: "opener",
  },
]);

function teardown() {
  sql(`delete from drip_sequence_versions where sequence_id = ${q(SEQ_ID)}`, true);
  sql(`delete from drip_sequences where id = ${q(SEQ_ID)}`, true);
  sql(
    `delete from drip_template_pool where id in (${[TPL_A, TPL_B, TPL_OPENER, TPL_RETIRED].map(q).join(",")})`,
    true,
  );
  console.log("teardown: fixture removed");
}

function setup() {
  teardown(); // idempotent

  sql(
    `insert into drip_sequences (id, tenant_id, name, description, trigger_event, trigger_filter, steps, enabled, one_per_lead, email_class)
     values (${q(SEQ_ID)}, ${q(TENANT)}, ${q("ZZ APEX SMOKE TEST — safe to delete")},
             ${q("Isolated fixture for smoke tests. Stage apex_smoke_test matches no lead.")},
             ${q("BRAVO_RECORD_STATUS_CHANGED")}, ${q(JSON.stringify({ entity: "lead", field: "stage", to: STAGE }))},
             ${q(STEPS)}, 0, 1, ${q("commercial")})`,
    true,
  );

  // approved_by / approved_at are REQUIRED for status='approved' — the
  // drip_template_pool_approval_audited CHECK enforces that an approval is
  // attributable to someone. Discovered by the constraint firing on the first
  // attempt, which is the guard working exactly as intended.
  const tpl = (id, role, subject, body, status, weight) =>
    `insert into drip_template_pool (id, tenant_id, brand, stage, role, subject, body_text, status, weight, source, created_by, approved_by, approved_at)
     values (${q(id)}, ${q(TENANT)}, ${q("sunbiz")}, ${q(STAGE)}, ${q(role)}, ${q(subject)}, ${q(body)}, ${q(status)}, ${weight}, ${q("seed")}, ${q("apex-smoke-test")},
             ${status === "approved" ? q("apex-smoke-test") : "NULL"},
             ${status === "approved" ? "strftime('%Y-%m-%dT%H:%M:%fZ','now')" : "NULL"})`;

  sql(tpl(TPL_A, "nudge", "POOL A subject", "POOL A body text.", "approved", 3), true);
  sql(tpl(TPL_B, "nudge", "POOL B subject", "POOL B body text.", "approved", 1), true);
  sql(tpl(TPL_OPENER, "opener", "POOL OPENER subject", "POOL OPENER body.", "approved", 1), true);
  sql(tpl(TPL_RETIRED, "nudge", "POOL RETIRED subject", "POOL RETIRED body.", "retired", 1), true);

  console.log(`setup: sequence ${SEQ_ID} (stage ${STAGE}), 4 pool templates`);
}

function show() {
  console.log(JSON.stringify(sql(`select id, name, enabled, daily_email_cap, steps from drip_sequences where id = ${q(SEQ_ID)}`), null, 2));
  console.log(JSON.stringify(sql(`select id, role, status, weight, subject from drip_template_pool where stage = ${q(STAGE)} order by id`), null, 2));
}

const cmd = process.argv[2];
if (cmd === "setup") setup();
else if (cmd === "teardown") teardown();
else if (cmd === "show") show();
else {
  console.error("usage: node scripts/smoke-drips-fixture.mjs setup|teardown|show");
  process.exit(2);
}
