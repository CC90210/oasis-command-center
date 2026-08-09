/**
 * scripts/verify-sms-receipts.ts
 *
 * Proves the SMS delivery-truth pipeline against REAL carrier data, not fixtures.
 *
 * WHY THIS EXISTS. The unit tests pin the rules; they cannot prove that the
 * reconciler finds our message in a live TextTorrent thread and reads the right
 * field off it. That gap is exactly where the 2026-07-27 outage lived: every
 * layer looked correct and the channel was dead for ten days.
 *
 * What it does, against a chat id you pass in:
 *   1. Opens receipts for the API-sent messages on that thread, status 'unknown'
 *      (it is told nothing about the outcome).
 *   2. Runs the real reconcileReceipts().
 *   3. Reports what the carrier actually said, and the breaker's verdict.
 *
 * Step 1 is deliberately blind so step 2 has to discover the truth on its own.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-sms-receipts.ts <chatId> [--apply]
 *
 * Dry-run by default. Reads credentials the way scripts/apply_migration.py does
 * and prints no secrets.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

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

const CHAT_ID = process.argv[2];
const APPLY = process.argv.includes("--apply");
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

if (!CHAT_ID || !/^\d+$/.test(CHAT_ID)) {
  console.error("usage: verify-sms-receipts.ts <chatId> [--apply]");
  process.exit(2);
}

/** The field-encryption passphrase lives only on Vercel; pull it the same way
 *  the running app has it injected, never from a file on disk. */
async function loadFieldKeyFromVercel(): Promise<void> {
  if (process.env.BRAVO_FIELD_ENCRYPTION_KEY) return;
  const token = process.env.CC_VERCEL_TOKEN || process.env.VERCEL_TOKEN;
  if (!token) throw new Error("no Vercel token to fetch BRAVO_FIELD_ENCRYPTION_KEY");
  const H = { Authorization: `Bearer ${token}` };
  const projects = await (await fetch("https://api.vercel.com/v9/projects?limit=100", { headers: H })).json();
  const proj = (projects.projects || []).find((p: { name: string }) => p.name === "agent-dashboard");
  if (!proj) throw new Error("agent-dashboard project not found");
  const envs = await (await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env?limit=500`, { headers: H })).json();
  const row = (envs.envs || []).find(
    (e: { key: string; target?: string[] }) => e.key === "BRAVO_FIELD_ENCRYPTION_KEY" && (e.target || []).includes("production"),
  );
  if (!row) throw new Error("BRAVO_FIELD_ENCRYPTION_KEY not found on the production target");
  const j = await (await fetch(`https://api.vercel.com/v1/projects/${proj.id}/env/${row.id}`, { headers: H })).json();
  if (typeof j?.value !== "string") throw new Error("could not decrypt the Vercel env value");
  process.env.BRAVO_FIELD_ENCRYPTION_KEY = j.value;
}

async function main(): Promise<void> {
  await loadFieldKeyFromVercel();

  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { getTextTorrentCredentials, getThreadRaw } = await import("@/lib/integrations/texttorrent");
  const { reconcileReceipts, readRecentReceipts } = await import("@/lib/sms/delivery-receipts");
  const { breakerVerdict, normalizeCarrierStatus, parseTtTimestamp } = await import("@/lib/sms/carrier-status");

  const db = getServiceSupabase();
  const creds = await getTextTorrentCredentials(TENANT, { actAsEmail: null });
  const messages = await getThreadRaw(creds, CHAT_ID, { limit: 30 });

  const ours = messages.filter(
    (m) => String(m.direction ?? "").toLowerCase() === "outbound" && String(m.platform ?? "") === "api",
  );
  console.log(`thread ${CHAT_ID}: ${messages.length} messages, ${ours.length} API-sent outbound`);
  if (ours.length === 0) {
    console.log("nothing to verify on this thread");
    return;
  }

  // What the carrier really said — printed BEFORE reconciliation so the expected
  // answer is on the record and the reconciler cannot be graded after the fact.
  console.log("\nground truth (read straight off the thread):");
  for (const m of ours) {
    console.log(
      `  ${String(m.created_at)}  ${normalizeCarrierStatus(m.api_send_status).padEnd(9)} ` +
        `sid=${m.msg_sid ?? "null"}  "${String(m.message ?? "").slice(0, 42)}"`,
    );
  }

  if (!APPLY) {
    console.log("\nDRY RUN - no receipts opened. Re-run with --apply.");
    return;
  }

  // Open receipts knowing only that we sent something. Status 'unknown'.
  const rows = ours.map((m) => ({
    tenant_id: TENANT,
    chat_id: String(CHAT_ID),
    rep_key: "verify",
    act_as_email: null,
    body_hash: createHash("sha256").update(String(m.message ?? "").trim(), "utf8").digest("hex"),
    sent_at: new Date(parseTtTimestamp(m.created_at) ?? Date.now()).toISOString(),
    carrier_status: "unknown",
  }));
  const ins = await db
    .from("sms_delivery_receipts")
    .upsert(rows, { onConflict: "tenant_id,chat_id,body_hash,sent_at" })
    .select("id");
  if (ins.error) throw new Error(`seed failed: ${ins.error.message}`);
  console.log(`\nopened ${ins.data?.length ?? 0} receipt(s), all status 'unknown'`);

  const result = await reconcileReceipts(TENANT);
  console.log("\nreconcile:", JSON.stringify(result));

  const after = await db
    .from("sms_delivery_receipts")
    .select("carrier_status, msg_sid, segments, credits, resolved_at")
    .eq("tenant_id", TENANT)
    .eq("chat_id", String(CHAT_ID));
  console.log("\nreceipts after reconciliation:");
  for (const r of after.data || []) {
    console.log(
      `  ${String(r.carrier_status).padEnd(9)} sid=${r.msg_sid ?? "null"} seg=${r.segments} credits=${r.credits} ` +
        `resolved=${r.resolved_at ? "yes" : "no"}`,
    );
  }

  const recent = await readRecentReceipts(TENANT, { sinceMs: Date.now() - 24 * 3_600_000 });
  console.log("\nbreaker:", JSON.stringify(breakerVerdict(recent)));
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
