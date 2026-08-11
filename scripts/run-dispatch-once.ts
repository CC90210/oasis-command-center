/**
 * scripts/run-dispatch-once.ts
 *
 * Run one drip dispatch cycle by hand.
 *
 * WHY. The Vercel crons have not executed since 2026-08-06 and every
 * configuration explanation has been ruled out: registered, enabled, pinned to
 * the current production deployment, CRON_SECRET present on production, routes
 * reachable, no deployment protection, active Pro plan with no billing block.
 * That leaves two possibilities which look identical from the database — the
 * ENGINE is broken, or the SCHEDULER is. This separates them, because it drives
 * the engine with the scheduler removed from the picture.
 *
 * It is also the manual lever while the scheduler is down.
 *
 * DRY RUN BY DEFAULT. Without --send, DRIPS_LIVE is forced off, so the executor
 * renders, logs and advances rows without a byte reaching a merchant. Pass
 * --send only when you intend real outbound.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/run-dispatch-once.ts
 *   node --conditions=react-server --import tsx scripts/run-dispatch-once.ts --send
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

const SEND = process.argv.includes("--send");

async function loadFieldKeyFromVercel(): Promise<void> {
  if (process.env.BRAVO_FIELD_ENCRYPTION_KEY) return;
  const token = process.env.CC_VERCEL_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) throw new Error("no Vercel token to fetch BRAVO_FIELD_ENCRYPTION_KEY");
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch("https://api.vercel.com/v9/projects?limit=100", { headers: H })).json();
  const proj = (projects.projects || []).find((p: { name: string }) => p.name === "agent-dashboard");
  const envs = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env?limit=500`, { headers: H })).json();
  const row = (envs.envs || []).find(
    (e: { key: string; target?: string[] }) =>
      e.key === "BRAVO_FIELD_ENCRYPTION_KEY" && (e.target || []).includes("production"),
  );
  if (!row) throw new Error("BRAVO_FIELD_ENCRYPTION_KEY not found on production");
  const j = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${row.id}`, { headers: H })).json();
  if (typeof j?.value !== "string") throw new Error("could not read BRAVO_FIELD_ENCRYPTION_KEY");
  process.env.BRAVO_FIELD_ENCRYPTION_KEY = j.value;
}

async function main(): Promise<void> {
  await loadFieldKeyFromVercel();

  if (!SEND) {
    // Forced OFF, not merely absent: .env.agents may well carry DRIPS_LIVE=1,
    // and inheriting it would turn a diagnostic into a live blast.
    process.env.DRIPS_LIVE = "0";
    console.log("DRY RUN — DRIPS_LIVE forced off. Rows render, log and advance; nothing is sent.\n");
  } else {
    console.log(`LIVE — DRIPS_LIVE=${process.env.DRIPS_LIVE ?? "(unset)"}. Real messages may go out.\n`);
  }

  const { runDispatchDrips } = await import("@/lib/drips/executor");
  const started = Date.now();
  const result = await runDispatchDrips();
  console.log(JSON.stringify(result, null, 2));
  console.log(`\ntook ${Math.round((Date.now() - started) / 1000)}s`);

  // The point of the exercise: if rows were claimed and processed here, the
  // engine is healthy and the fault is purely the scheduler.
  if (result.claimed > 0) {
    console.log("\nENGINE IS HEALTHY — it claimed and processed work. The fault is the Vercel scheduler.");
  } else if (result.processed === 0) {
    console.log("\nClaimed nothing. Either there is no due work, or the engine returns early.");
  }
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
