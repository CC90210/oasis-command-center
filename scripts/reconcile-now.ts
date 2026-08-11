/**
 * scripts/reconcile-now.ts — run the reconciliation cron body on demand.
 *
 * The cron endpoint requires Vercel's `x-vercel-cron` header, which the platform
 * strips from external callers, so it cannot be triggered by curl. This runs the
 * same function against production for verification and manual catch-up.
 *
 * Read-mostly: it only closes receipts with the carrier's own verdict.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/reconcile-now.ts
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
  const { reconcileReceipts } = await import("@/lib/sms/delivery-receipts");
  const { smsSendAllowed, resetBreakerCache } = await import("@/lib/sms/send-breaker");
  const db = getServiceSupabase();

  const r = await reconcileReceipts(TENANT);
  console.log("reconcile:", JSON.stringify(r));

  const rows = await db
    .from("sms_delivery_receipts")
    .select("carrier_status, msg_sid, segments, credits, from_number, sent_at, resolved_at")
    .eq("tenant_id", TENANT)
    .order("sent_at", { ascending: false })
    .limit(8);
  console.log("\nmost recent receipts:");
  for (const x of rows.data || []) {
    console.log(
      `  ${String(x.sent_at).slice(0, 19)}  ${String(x.carrier_status).padEnd(9)} ` +
        `from=${x.from_number ?? "?"} seg=${x.segments ?? "-"} credits=${x.credits ?? "-"} ` +
        `sid=${x.msg_sid ? String(x.msg_sid).slice(0, 10) : "null"} resolved=${x.resolved_at ? "yes" : "no"}`,
    );
  }

  resetBreakerCache(TENANT);
  console.log("\nbreaker:", JSON.stringify(await smsSendAllowed(TENANT, { force: true })));
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
