/**
 * scripts/sms-resume.mjs — turn texting back on, but only against evidence.
 *
 * SMS was halted 2026-08-20 at three levels: queued rows cancelled, SMS
 * sequences disabled, tenant caps set to zero. This reverses that, and refuses
 * unless at least one line has delivered TWICE at least 30 minutes apart.
 *
 * Usage (from the repo root):
 *   node --conditions=react-server --import tsx scripts/sms-resume.mjs check
 *   node --conditions=react-server --import tsx scripts/sms-resume.mjs resume [--reenroll]
 *
 * `check` is read-only and always safe. `resume` writes. `--reenroll` also
 * re-queues the leads whose rows were cancelled by the halt; it is a separate
 * flag because it is the one irreversible-feeling part (it puts merchants back
 * in a sending queue) and should be a deliberate keystroke.
 */

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const verb = process.argv[2] || "check";
const REENROLL = process.argv.includes("--reenroll");

const { canaryStatus } = await import("@/lib/sms/canary");
const { resumePlan } = await import("@/lib/sms/resume-core");
const { getServiceSupabase } = await import("@/lib/supabase-server");
const db = getServiceSupabase();

const { results, error } = await canaryStatus(TENANT);
const plan = resumePlan(error ? null : results);

console.log("CANARY STATUS");
for (const r of results) {
  console.log(`  ${String(r.number).padEnd(15)} ${String(r.verdict).padEnd(13)} deliv=${r.delivered} fail=${r.failed} none=${r.unresolved}  ${r.reason}`);
}
if (error) console.log(`  READ ERROR: ${error}`);

console.log(`\nRESUME: ${plan.allowed ? "ALLOWED" : "BLOCKED"}`);
console.log(`  ${plan.reason}`);

if (!plan.allowed) {
  console.log("\nNothing changed. Send another canary round and try again:");
  console.log("  node --conditions=react-server --import tsx scripts/sms-canary.mjs send --to +1XXXXXXXXXX");
  process.exit(1);
}
if (verb !== "resume") {
  console.log(`\nRead-only. Re-run with 'resume' to apply.`);
  process.exit(0);
}

// 1. Volume ceilings. These are the same controls the Drips tab edits, so the
//    restart is visible and reversible from the UI rather than a hidden switch.
const caps = await db.from("drip_channel_limits").update({
  sms_daily: plan.dailyCap,
  sms_hourly: plan.hourlyCap,
  updated_at: new Date().toISOString(),
}).eq("tenant_id", TENANT);
if (caps.error) { console.error(`FAILED to set caps: ${caps.error.message}`); process.exit(1); }
console.log(`\ncaps set to ${plan.dailyCap}/day, ${plan.hourlyCap}/hour`);

// 2. Re-enable ONLY what the halt turned off.
//
// The first cut asked "which SMS sequences are disabled?" and enabled all of
// them. Run live on 2026-08-20 it switched on SIX, but the halt had disabled
// four: "Submitted - underwriting wait" and "Inquiry Welcomer" were off by
// Adon's decision long before any of this, and the resume silently reversed
// that. I had to turn them back off by hand.
//
// Restoring a backup is not the same as turning everything on. A resume script
// must not be able to start something a human deliberately stopped, so the list
// is EXPLICIT and anything not named stays exactly as it is.
const HALTED_BY_THE_2026_08_20_STOP = [
  "Accelerated statement chase",
  "Sent application - completion drip",
  "Live Subs - broker intro (SMS)",
  "Follow-up (phone only) - SMS",
];
const only = process.argv.includes("--sequences")
  ? String(process.argv[process.argv.indexOf("--sequences") + 1] || "").split(",").map((x) => x.trim()).filter(Boolean)
  : HALTED_BY_THE_2026_08_20_STOP;

let enabled = 0;
let alreadyOn = 0;
for (const name of only) {
  const cur = await db.from("drip_sequences").select("id, enabled").eq("tenant_id", TENANT).eq("name", name).maybeSingle();
  if (cur.error) { console.error(`  FAILED to read ${name}: ${cur.error.message}`); continue; }
  if (!cur.data) { console.error(`  NOT FOUND: ${name} (nothing enabled)`); continue; }
  if (cur.data.enabled === true || cur.data.enabled === 1) { alreadyOn++; continue; }
  const up = await db.from("drip_sequences").update({ enabled: true }).eq("id", cur.data.id).eq("tenant_id", TENANT);
  // The adapter RETURNS errors rather than throwing; ignoring this would report
  // a resume that never happened.
  if (up.error) { console.error(`  FAILED to enable ${name}: ${up.error.message}`); continue; }
  console.log(`  re-enabled: ${name}`);
  enabled++;
}
console.log(`${enabled} SMS sequence(s) re-enabled, ${alreadyOn} already on. Nothing else was touched.`);

// 3. Optionally re-queue the halted leads. Cancelled rows do not block
//    re-enrolment (the enroller's prior-run check excludes 'cancelled'), so the
//    enrol cron will pick these leads up on its own schedule and at the new,
//    much smaller cap. Nothing is force-sent here.
if (REENROLL) {
  const halted = await db.from("drip_runs").select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT).eq("channel", "sms").eq("status", "cancelled")
    .like("last_error", "%halted 2026-08-20%");
  console.log(`\n${halted.count ?? 0} row(s) were cancelled by the halt.`);
  console.log("They re-enrol naturally on the next enrol cron - cancelled rows do not block re-entry.");
  console.log(`At ${plan.dailyCap}/day this drains slowly and on purpose.`);
} else {
  console.log("\n(--reenroll not passed: halted rows stay cancelled and will re-enrol on the normal cron)");
}

console.log("\nWatch: sms.carrier_verdict_rate and sms.receipts_unresolved on the health check.");
console.log("A line that starts failing now benches itself after 3 consecutive carrier failures.");
