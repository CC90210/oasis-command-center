/**
 * scripts/verify-tenant-discovery.ts
 *
 * The reconcile cron returns 500 BEFORE touching any receipt if
 * tenantsWithOpenReceipts() returns null. That failure mode is indistinguishable
 * from "the cron never ran": both leave every receipt at attempts=0,
 * last_checked_at=never. This tells the two apart.
 *
 * Read-only.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-tenant-discovery.ts
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

async function main(): Promise<void> {
  const { tenantsWithOpenReceipts } = await import("@/lib/sms/delivery-receipts");
  const t = await tenantsWithOpenReceipts();
  if (t === null) {
    console.log("tenantsWithOpenReceipts -> NULL");
    console.log("  the cron would 500 here without touching a single receipt.");
    process.exit(1);
  }
  console.log(`tenantsWithOpenReceipts -> ${t.length} tenant(s): ${t.join(", ") || "(none)"}`);
  console.log("  discovery is healthy, so an untouched receipt means the cron did not run at all.");
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
