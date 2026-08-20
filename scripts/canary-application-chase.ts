/**
 * scripts/canary-application-chase.ts — prove the rebuilt Form 2 chase on ONE
 * synthetic lead before any real merchant is enrolled.
 *
 * Creates a lead in `viewed_application` pointed at a mailbox you control and
 * enrols it in the chase. Deliberately leaves `application_url` UNSET so the
 * executor has to mint a fresh per-lead link, exercising the mint-and-halt
 * guard rather than a pre-baked value.
 *
 * Business names avoid the tenant's junk lender records (`TEST 1`, `TEST 2`,
 * `Test 3`), which legitimately trip the lender-name guard and would make a
 * clean run look broken.
 *
 * DRY-RUN BY DEFAULT.
 *   node --conditions=react-server --import tsx scripts/canary-application-chase.ts
 *   node --conditions=react-server --import tsx scripts/canary-application-chase.ts --apply --to you@example.com
 *   node --conditions=react-server --import tsx scripts/canary-application-chase.ts --cleanup
 */

import { readFileSync } from "node:fs";

function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadEnvFile("C:/Users/echel/JARVIS/.env.agents");

const APPLY = process.argv.includes("--apply");
const CLEANUP = process.argv.includes("--cleanup");
const toArg = process.argv.indexOf("--to");
const TO = toArg >= 0 ? (process.argv[toArg + 1] || "") : "";
/** Step to start at. 1 = the first message the old sequence never sent. */
const stepArg = process.argv.indexOf("--step");
const START_STEP = stepArg >= 0 ? parseInt(process.argv[stepArg + 1] || "1", 10) : 1;

const TENANT_SLUG = "submissions";
const CHASE = "Viewed application nudge";
const TAG = "APEX-CHASE-CANARY";

async function main() {
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { SUNBIZ_VIEWED_APPLICATION_STEPS } = await import("@/lib/drips/sunbiz-application-chase");
  const db = getServiceSupabase();

  const t = await db.from("tenants").select("id").eq("slug", TENANT_SLUG).maybeSingle();
  const tenantId = (t.data as { id?: string } | null)?.id;
  if (!tenantId) throw new Error(`tenant ${TENANT_SLUG} not found`);

  if (CLEANUP) {
    const doomed = await db
      .from("tenant_records")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "lead")
      .like("data", `%${TAG}%`);
    const ids = ((doomed.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) {
      await db.from("drip_runs").delete().eq("tenant_id", tenantId).eq("lead_id", id);
      await db.from("tenant_records").delete().eq("tenant_id", tenantId).eq("id", id);
    }
    console.log(`cleaned up ${ids.length} canary lead(s) and their runs`);
    return;
  }

  const seq = await db
    .from("drip_sequences")
    .select("id, name, steps, enabled")
    .eq("tenant_id", tenantId)
    .eq("name", CHASE)
    .maybeSingle();
  const sequence = seq.data as { id: string; enabled: boolean; steps: unknown } | null;
  if (!sequence) throw new Error(`sequence "${CHASE}" not found`);

  const liveSteps = typeof sequence.steps === "string" ? JSON.parse(sequence.steps) : sequence.steps;
  console.log(`\nsequence live state: ${liveSteps.length} steps, enabled=${sequence.enabled}`);
  const smsCount = (liveSteps as Array<{ channel?: string }>).filter((s) => s.channel === "sms").length;
  console.log(`  channels: ${smsCount === 0 ? "email only (correct)" : `*** ${smsCount} SMS STEP(S) STILL PRESENT ***`}`);
  if (liveSteps.length !== SUNBIZ_VIEWED_APPLICATION_STEPS.length) {
    console.log(`  WARNING: live has ${liveSteps.length} steps, code defines ${SUNBIZ_VIEWED_APPLICATION_STEPS.length}. Run the migration first.`);
  }

  if (!TO) {
    console.log("\nNo --to address given. Nothing to do.\n");
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(TO)) throw new Error(`--to is not an email: ${TO}`);

  const data = {
    business_name: "Harborview Dental Group",
    contact_name: "Ray Mitchell",
    email: TO,
    phone: "5555550142",
    stage: "viewed_application",
    note: TAG,
    // application_url deliberately absent: the executor must mint one.
  };

  console.log(`\nwould create lead  : ${data.business_name} <${data.email}>`);
  console.log(`would enrol at step: ${START_STEP} (${SUNBIZ_VIEWED_APPLICATION_STEPS[START_STEP]?.subject})`);
  console.log(`application_url    : deliberately unset, so the executor mints a per-lead link`);
  console.log(`after it sends, the executor chains steps ${START_STEP + 1}..${SUNBIZ_VIEWED_APPLICATION_STEPS.length - 1} on their own delays`);

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing written. Re-run with --apply --to <address>.\n");
    return;
  }

  const ins = await db.from("tenant_records").insert({
    tenant_id: tenantId,
    entity_type: "lead",
    data: JSON.stringify(data),
  });
  if (ins.error) throw new Error(`lead insert failed: ${ins.error.message}`);

  const found = await db
    .from("tenant_records")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("entity_type", "lead")
    .like("data", `%${TAG}%`)
    .order("created_at", { ascending: false })
    .limit(1);
  const leadId = ((found.data ?? []) as Array<{ id: string }>)[0]?.id;
  if (!leadId) throw new Error("could not read back the canary lead");

  const run = await db.from("drip_runs").insert({
    tenant_id: tenantId,
    lead_id: leadId,
    sequence_id: sequence.id,
    sequence_name: CHASE,
    step_index: START_STEP,
    channel: "email",
    scheduled_for: new Date(Date.now() - 60_000).toISOString(), // due now
    status: "scheduled",
  });
  if (run.error) throw new Error(`enrolment failed: ${run.error.message}`);

  console.log(`\nlead ${leadId} created and enrolled at step ${START_STEP}, due now.`);
  console.log(`The dispatch cron picks it up on its next tick.\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
