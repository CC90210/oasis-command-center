/**
 * scripts/smoke-drips-modules.ts — call the REAL I/O modules against production.
 *
 * The other two suites prove the rules (pure) and the render (components), but
 * both reach the database through SQL I hand-wrote. That leaves the actual
 * production code path — lib/turso-postgrest.ts under getServiceSupabase(), and
 * the query builders in sequence-volume.ts / activity-queries.ts — unexercised.
 *
 * That gap is exactly where a silent failure lives. An unsupported operator in
 * the compat shim does not throw a visible error: sequenceDailyCaps returns
 * null, the budget degrades, and a cap an operator set is quietly never
 * applied. The chart would still look right, because the chart is drawn from a
 * different call. So these functions get called for real.
 *
 * READ-ONLY. Nothing here writes.
 *
 * Run: node --conditions=react-server --import tsx scripts/smoke-drips-modules.ts
 */

import { readFileSync } from "node:fs";

// Load the app's Turso env in-process. Values are never printed — only the
// NAMES of what resolved, so a missing credential is diagnosable without
// exposing one.
function loadEnv(): string[] {
  const resolved: string[] = [];
  let txt = "";
  try {
    txt = readFileSync("C:/Users/echel/JARVIS/.env.agents", "utf8");
  } catch {
    return resolved;
  }
  const env: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    env[k.trim()] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  const map: Array<[string, string[]]> = [
    ["TURSO_DATABASE_URL", ["TURSO_BRAVO_EMPIRE_URL", "TURSO_DATABASE_URL", "TURSO_DB_URL"]],
    ["TURSO_AUTH_TOKEN", ["TURSO_BRAVO_EMPIRE_AUTH_TOKEN", "TURSO_AUTH_TOKEN"]],
  ];
  for (const [target, candidates] of map) {
    for (const c of candidates) {
      if (env[c]) {
        process.env[target] = env[c];
        resolved.push(`${target}<-${c}`);
        break;
      }
    }
  }
  // The switch that routes getServiceSupabase() at the Turso adapter. Without
  // it the client would try to reach Supabase, which no longer exists.
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
  resolved.push("EMPIRE_DATA_BACKEND=turso_cloud");
  return resolved;
}

const resolvedNames = loadEnv();

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

let pass = 0;
const fails: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fails.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main(): Promise<void> {
  console.log("DRIPS MODULE SMOKE — the real query builders, against production\n");
  console.log(`  env resolved: ${resolvedNames.join(", ") || "(none)"}`);
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.log("\n  SKIPPED: no Turso credentials resolved — cannot exercise the real modules.");
    console.log("  This is a GAP, not a pass. Reporting it rather than printing a green tick.");
    process.exit(2);
  }

  const { sequenceDailyVolume, sequenceSentToday, sequenceDailyCaps } = await import("../lib/drips/sequence-volume");
  const { recentDripActivity, dripFailureSummary } = await import("../lib/drips/activity-queries");
  const { loadApprovedPool, loadApprovedPoolOrThrow } = await import("../lib/drips/template-pool-store");
  _db = await importDb();

  // ── sequence-volume.ts ───────────────────────────────────────────────────
  console.log("\n=== lib/drips/sequence-volume.ts ===");
  {
    const report = await sequenceDailyVolume(TENANT, { days: 14 });
    check("sequenceDailyVolume() returns without error", report.error === null, report.error || "");
    check("it found real volume", report.volumes.length > 0, `${report.volumes.length} sequences`);
    check("it did not silently truncate", report.truncated === false);
    console.log(`  top: ${report.volumes.slice(0, 3).map((v) => `${v.sequenceName}=${v.total}`).join(", ")}`);

    // THE call the send path makes. If the shim cannot express this query, it
    // returns null, the budget degrades, and a cap is never applied — with no
    // error anywhere.
    const sent = await sequenceSentToday(TENANT);
    check("sequenceSentToday() does not return null (a null here disables every cap)", sent !== null);
    if (sent) console.log(`  keys today: ${sent.size}`);

    const caps = await sequenceDailyCaps(TENANT);
    check("sequenceDailyCaps() does not return null", caps !== null);
    check("no live sequence currently carries a cap", (caps?.size ?? 0) === 0, `${caps?.size ?? 0} keys`);
  }

  // ── activity-queries.ts ──────────────────────────────────────────────────
  console.log("\n=== lib/drips/activity-queries.ts ===");
  {
    const rows = await recentDripActivity(TENANT, { limit: 120 });
    check("recentDripActivity() returns rows", rows.length > 0, `${rows.length}`);
    check("every row has a resolved status", rows.every((r) => typeof r.status === "string" && r.status.length > 0));

    // The two-query split must surface BOTH kinds, or the tab is half blind.
    const open = rows.filter((r) => !r.sentAt).length;
    const done = rows.filter((r) => r.sentAt).length;
    check("both open AND completed rows come back (the split is working)", open > 0 && done > 0, `${open} open / ${done} completed`);
    check("open rows sort first", rows.findIndex((r) => Boolean(r.sentAt)) === -1 || rows.findIndex((r) => Boolean(r.sentAt)) >= open - 1);

    const brands = new Set(rows.map((r) => r.brand));
    check("brand is resolved on every row", rows.every((r) => r.brand === "sunbiz" || r.brand === "bluerise"), [...brands].join(","));

    const summary = await dripFailureSummary(TENANT);
    check("dripFailureSummary() returns", typeof summary.realSends === "number", JSON.stringify(summary));
    check("the summary did not truncate", summary.truncated === false);
  }

  // ── template-pool-store.ts ───────────────────────────────────────────────
  console.log("\n=== lib/drips/template-pool-store.ts ===");
  {
    // NOT `await getDb()`: getServiceSupabase() returns a Proxy, and awaiting
    // it makes the runtime probe `.then` on it — which the proxy's own guard
    // correctly refuses ("Supabase is not configured and
    // EMPIRE_DATA_BACKEND=turso_cloud"). The guard is right; the await was mine.
    const db = getDb();
    const safe = await loadApprovedPool(db, TENANT);
    const strict = await loadApprovedPoolOrThrow(db, TENANT);
    check("both loaders agree when the read works", safe.length === strict.length, `${safe.length} approved`);
    // Only the smoke fixture's templates should be approved right now.
    const realStage = strict.filter((t) => t.stage !== "apex_smoke_test");
    check(
      "NOTE: approved templates exist for REAL stages",
      realStage.length > 0,
      realStage.length === 0 ? "none — the interchange has nothing to offer in production" : `${realStage.length}`,
    );
  }

  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) console.log("failing:\n  - " + fails.join("\n  - "));
  process.exit(fails.length ? 1 : 0);
}

let _db: Awaited<ReturnType<typeof importDb>> | null = null;
async function importDb() {
  return (await import("../lib/supabase-server")).getServiceSupabase;
}
function getDb() {
  if (!_db) throw new Error("db factory not initialised");
  return _db();
}

main().catch((err) => {
  console.error("MODULE SMOKE ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
