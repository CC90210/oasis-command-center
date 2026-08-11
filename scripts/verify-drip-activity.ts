/**
 * scripts/verify-drip-activity.ts
 *
 * Prove the Drips activity tab reports the truth, against production.
 *
 * The specific lie it guards against: `drip_runs.status='sent'` includes rows
 * that merely ADVANCED. Measured 2026-08-10, 864 of 1,348 such rows had a NULL
 * from_identity and never reached a provider. A tab that trusted the column
 * would claim 1,348 sends where 484 happened, and compute a failure rate on a
 * denominator that is two-thirds fiction.
 *
 * So this reconciles the classifier against the raw counts and fails if the
 * parts do not add up to the whole.
 *
 * Read-only.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-drip-activity.ts
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
// Env file path comes from the environment. It used to be one developer's
// absolute Windows path, which on any other machine failed SILENTLY (loadEnvFile
// swallows a missing file) and left the script running against whatever
// credentials the shell happened to hold.
const ENV_FILE = process.env.DRIP_VERIFY_ENV_FILE || process.env.APEX_ENV_FILE || "";
if (ENV_FILE) loadEnvFile(ENV_FILE);

// No default. A tenant id is customer data and does not belong in source, and a
// hardcoded one means a run with no arguments quietly targets a specific
// production tenant that nobody chose.
const TENANT = process.env.SUNBIZ_TENANT_ID || "";
if (!TENANT) {
  console.error(
    "SUNBIZ_TENANT_ID is not set. Refusing to guess a tenant: this reads production drip rows, " +
      "and the wrong id would report another tenant's numbers as this one's.",
  );
  process.exit(2);
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { recentDripActivity, dripFailureSummary } = await import("@/lib/drips/activity-queries");
  const { classifyRunStatus, outcomeWindow } = await import("@/lib/drips/activity-core");
  const db = getServiceSupabase();

  const since = Date.now() - 60 * 24 * 3_600_000;

  // Raw truth, straight from the table — through the SAME window the summary
  // uses. A harness that measures a different window than the code it is
  // checking reports a disagreement that is its own, and the reflex is then to
  // "fix" working code until the harness agrees. Here the divergence is exactly
  // the backlog case the window was changed for: a run scheduled before the
  // cutoff but sent inside it.
  const raw = await db
    .from("drip_runs")
    .select("status, from_identity")
    .eq("tenant_id", TENANT)
    .or(outcomeWindow(new Date(since).toISOString()))
    .limit(5000);
  if (raw.error) throw new Error(raw.error.message);
  const rows = raw.data || [];
  console.log(`raw drip_runs in window: ${rows.length}\n`);

  const rawSentColumn = rows.filter((r) => r.status === "sent" || r.status === "done").length;
  const classified = rows.map((r) => classifyRunStatus(r));
  const realSends = classified.filter((c) => c === "sent").length;
  const skipped = classified.filter((c) => c === "skipped").length;

  console.log("the distinction this whole file exists for:");
  console.log(`  rows whose STATUS says sent/done : ${rawSentColumn}`);
  console.log(`  rows that actually reached a provider : ${realSends}`);
  console.log(`  rows that merely ADVANCED : ${skipped}`);
  check(
    "status column overstates real sends (or they match, if every row is genuine)",
    rawSentColumn >= realSends,
    `${rawSentColumn} >= ${realSends}`,
  );
  // The EXACT identity, not an inequality that holds by construction.
  // `realSends + skipped <= rawSentColumn + 1` is true for every possible input
  // because both counters are subsets of the sent/done rows, so it printed "ok"
  // whatever the classifier did. A harness that cannot fail gives exactly the
  // false confidence this tab was built to remove.
  const dryRun = classified.filter((c) => c === "dry_run").length;
  check(
    "every sent/done row lands in exactly one bucket",
    realSends + skipped + dryRun === rawSentColumn,
    `${realSends} + ${skipped} + ${dryRun} = ${realSends + skipped + dryRun} vs ${rawSentColumn}`,
  );

  // The summary must agree with a hand count over the same window.
  const summary = await dripFailureSummary(TENANT, since);
  const handFailed = classified.filter((c) => c === "failed").length;
  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  check("summary realSends matches a hand count", summary.realSends === realSends, `${summary.realSends} vs ${realSends}`);
  check("summary failed matches a hand count", summary.failed === handFailed, `${summary.failed} vs ${handFailed}`);
  check(
    "failure rate is over real sends, not all rows",
    summary.failureRatePct === null ||
      summary.failureRatePct === Math.round((summary.failed / (summary.realSends + summary.failed)) * 100),
  );
  // An empty window must read as unknown, never as a healthy zero.
  const emptySummary = await dripFailureSummary(TENANT, Date.now() + 3_600_000);
  check("an empty window reports null, not 0%", emptySummary.failureRatePct === null);

  // The row feed must render and never leak another tenant's leads.
  const activity = await recentDripActivity(TENANT, { limit: 50 });
  console.log(`\nactivity rows returned: ${activity.length}`);
  // `activity.length >= 0` is true for every array. Assert the limit is
  // actually honoured, which is a property that CAN be wrong.
  check("the row feed honours its limit", activity.length <= 50, `${activity.length} <= 50`);
  check(
    "every row carries a resolved outcome",
    activity.every((r) => typeof r.status === "string" && r.status.length > 0),
  );
  // State the invariant, not a proxy for it. The old assertion required
  // status !== rawStatus, which is FALSE for every healthy row: a genuine send
  // classifies to "sent" from a raw "sent", so the check failed against correct
  // production data. A harness that fails on healthy input teaches its operator
  // to ignore it, and the next real failure goes unread.
  //
  // What actually matters: nothing whose raw status claims it went out may be
  // presented as a send without a provider identity behind it.
  check(
    "no row claims to have sent without a provider identity",
    activity.every(
      (r) =>
        !(r.rawStatus === "sent" || r.rawStatus === "done") ||
        r.status !== "sent" ||
        Boolean(r.fromIdentity && !String(r.fromIdentity).startsWith("dry:")),
    ),
  );
  for (const r of activity.slice(0, 5)) {
    console.log(`  ${String(r.scheduledFor).slice(0, 16)}  ${String(r.channel).padEnd(5)} ${r.status.padEnd(9)} ${r.brand.padEnd(8)} ${(r.error || r.fromIdentity || "").slice(0, 54)}`);
  }

  console.log(failures === 0 ? "\nACTIVITY VERIFIED AGAINST PRODUCTION" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
