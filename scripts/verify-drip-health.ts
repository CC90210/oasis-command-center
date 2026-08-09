/**
 * scripts/verify-drip-health.ts
 *
 * Runs every drip health check against PRODUCTION data and prints its verdict.
 *
 * WHY. A monitor's first act must not be a false alarm. sms.receipt_coverage
 * compares sends against receipts, and every send that predates the receipts
 * code has none — so without a floor the check would go red on deploy and page
 * about history rather than a fault. People learn to ignore a monitor that
 * cries wolf on day one, which is precisely the failure this subsystem exists
 * to remove. This is how we find that out BEFORE merging, not after.
 *
 * Read-only.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-drip-health.ts
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

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

async function main(): Promise<void> {
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { DRIP_CHECKS, runCheck } = await import("@/lib/health/drip-checks");
  const db = getServiceSupabase();
  const now = Date.now();

  console.log(`running ${DRIP_CHECKS.length} checks against production\n`);
  let broken = 0;
  for (const check of DRIP_CHECKS) {
    // Short history: this is a deploy-time sanity read, not the nightly digest.
    const r = await runCheck(db, TENANT, check, now, 3);
    const mark =
      r.verdict === "ok" ? "ok  " : r.verdict === "check_broken" ? "BROKEN" : r.verdict.toUpperCase();
    console.log(`${mark.padEnd(9)} ${check.id.padEnd(28)} observed=${String(r.observed).padEnd(6)} ${check.describe(r).slice(0, 110)}`);
    // A check that cannot run is never a pass. That single rule is why the
    // three-week outage was findable at all.
    if (r.verdict === "check_broken") broken++;
  }
  console.log(broken === 0 ? "\nno broken checks" : `\n${broken} CHECK(S) COULD NOT RUN`);
  process.exit(broken === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
