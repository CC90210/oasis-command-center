/**
 * scripts/verify-outbound-allocation.ts
 *
 * Prints the live outbound allocation: which mailbox or carrier every kind of
 * message goes to, resolved against the credentials actually present in
 * production.
 *
 * WHY IT IS A SCRIPT AND NOT A DOC. A written allocation goes stale the moment
 * a credential is added or a kill switch flips, and a stale allocation is worse
 * than none because it is believed. This reads the real state every time.
 *
 * Read-only.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-outbound-allocation.ts
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
  const { loadProviderAvailability } = await import("@/lib/routing/provider-availability");
  const { routeOutbound, reachableChannels, describeAllocation } = await import("@/lib/routing/outbound-routing");

  const available = await loadProviderAvailability(TENANT);

  console.log("PROVIDERS");
  for (const [id, s] of Object.entries(available)) {
    console.log(`  ${id.padEnd(14)} configured=${String(s.configured).padEnd(5)} enabled=${s.enabled}`);
  }

  console.log("\nALLOCATION");
  for (const line of describeAllocation(available)) console.log(`  ${line}`);

  console.log("\nRESOLVED ROUTES");
  const brands = ["sunbiz", "bluerise"] as const;
  const cases = [
    { channel: "email", purpose: "drip" },
    { channel: "email", purpose: "transactional" },
    { channel: "email", purpose: "lender_shopout" },
    { channel: "sms", purpose: "drip" },
    { channel: "sms", purpose: "rep_manual" },
  ] as const;
  for (const brand of brands) {
    console.log(`  ${brand}:`);
    for (const c of cases) {
      const d = routeOutbound({ channel: c.channel, purpose: c.purpose, brand, available });
      const verdict = d.send ? `-> ${d.provider} (as ${d.brand})` : `HOLD: ${d.reason}`;
      console.log(`    ${c.channel.padEnd(6)} ${c.purpose.padEnd(15)} ${verdict}`);
    }
    console.log(`    reachable channels: ${reachableChannels(brand, available).join(", ") || "(none)"}`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
