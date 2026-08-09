/**
 * scripts/smoke-drip-sms.ts
 *
 * End-to-end smoke test of the automatic drip SMS path, using the REAL
 * production functions at every step:
 *
 *   sms_sender_numbers  -> the sync-fed registry the send path actually reads
 *   resolveDripSmsIdentity -> the real per-rep act-as routing
 *   smsSendAllowed      -> the real breaker
 *   sendDripSms         -> the real send the drip executor calls
 *   openReceipt         -> the real receipt the executor opens
 *   reconcileReceipts   -> the real cron body
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not call runDispatchDrips(). There
 * are ~230 overdue drip rows aimed at real merchants, and a smoke test must not
 * become a blast. Instead it sends to a number WE OWN, so the machinery is
 * exercised without contacting anyone.
 *
 * EXPECTED RESULT while TextTorrent's API route is broken: the send returns 201
 * and the carrier reports `failed`. That is a PASS for this test — the point is
 * that the system now KNOWS, where before it recorded 'sent' and said nothing.
 *
 * Dry-run unless --send. Costs about one cent.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/smoke-drip-sms.ts --send
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
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

let failures = 0;
function step(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const { sendDripSms } = await import("@/lib/drips/send");
  const { openReceipt, reconcileReceipts } = await import("@/lib/sms/delivery-receipts");
  const { smsSendAllowed, resetBreakerCache } = await import("@/lib/sms/send-breaker");
  const db = getServiceSupabase();

  // 1) The live number registry the send path reads. A stale hardcoded list is
  //    what produced 1,070 sends from dead numbers in July.
  const live = await db
    .from("sms_sender_numbers")
    .select("number, rep_key, act_as_email")
    .eq("tenant_id", TENANT)
    .eq("active", true)
    .order("rep_key");
  const numbers = live.data || [];
  console.log("1) live sender registry");
  step("sms_sender_numbers has active numbers", numbers.length > 0, `${numbers.length} active`);
  if (!numbers.length) return finish();
  for (const n of numbers) console.log(`        ${n.rep_key.padEnd(8)} ${n.number}`);

  // Send FROM an admin/parent number TO another number we own.
  const from = numbers.find((n) => n.rep_key === "admin") || numbers[0];
  const dest = numbers.find((n) => n.number !== from.number);
  if (!dest) return finish("need two distinct numbers to test without touching a merchant");
  const toPhone = dest.number;

  // 2) The breaker, before anything is sent.
  console.log("\n2) breaker (pre-send)");
  const before = await smsSendAllowed(TENANT, { force: true });
  console.log(`        ${JSON.stringify(before)}`);
  step("breaker returned a verdict", typeof before.halt === "boolean");

  const body = `SunBiz automated drip smoke test ${new Date().toISOString().slice(0, 16)}Z. Internal check, no action needed.`;
  console.log(`\n3) send  from=${from.number} (${from.rep_key})  to=${toPhone}  len=${body.length}`);
  if (!SEND) {
    console.log("\nDRY RUN — nothing sent. Re-run with --send.");
    return;
  }
  if (before.halt && !before.halfOpen) {
    console.log("        breaker is HALTED and no probe is due — this is correct behaviour, not a failure.");
    console.log("        re-run after the probe interval, or clear SMS_BREAKER_DISABLED intentionally.");
    return finish();
  }

  const result = await sendDripSms(TENANT, toPhone, body, {
    actAsEmail: from.act_as_email ?? null,
    senderId: from.number,
    repKey: from.rep_key,
  });
  step("sendDripSms returned ok (this is only the HTTP 201)", result.ok === true, result.ok ? `chat ${result.chatId}` : result.error);
  if (!result.ok) return finish();

  // 4) The receipt the executor opens on every real send.
  const receiptId = await openReceipt(db, {
    tenantId: TENANT,
    chatId: String(result.chatId),
    repKey: from.rep_key,
    actAsEmail: from.act_as_email ?? null,
    fromNumber: from.number,
    toPhone,
    body,
  });
  step("receipt opened", receiptId !== null, receiptId ? `id ${String(receiptId).slice(0, 8)}` : "openReceipt returned null");

  // 5) Give the carrier a moment, then run the real reconciler.
  // Must exceed reconcileReceipts' MIN_AGE_MS (90s), which deliberately ignores
  // very fresh sends because the carrier has not ruled on them yet. Waiting less
  // than that reports "examined: 0" and looks like a reconciler bug when it is
  // the reconciler being correct.
  console.log("\n4) waiting 150s (MIN_AGE is 90s) for SignalHouse to report, then reconciling");
  await new Promise((r) => setTimeout(r, 150_000));
  const rec = await reconcileReceipts(TENANT);
  console.log(`        ${JSON.stringify(rec)}`);
  step("reconciler resolved the receipt", rec.resolved >= 1, `${rec.delivered} delivered, ${rec.failed} failed`);

  const row = await db
    .from("sms_delivery_receipts")
    .select("carrier_status, msg_sid, segments, credits, resolved_at")
    .eq("tenant_id", TENANT)
    .eq("id", receiptId as string)
    .maybeSingle();
  console.log(`\n5) carrier verdict: ${JSON.stringify(row.data)}`);
  const status = row.data?.carrier_status;
  step("the carrier's verdict was recorded, not assumed", status === "delivered" || status === "failed", `status=${status}`);
  if (status === "failed") {
    console.log("        ^ EXPECTED while the TextTorrent API route is broken.");
    console.log("          Before this build the same send was recorded 'sent' and nobody knew.");
  }

  // 6) The breaker, after — proving the verdict feeds back in.
  resetBreakerCache(TENANT);
  const after = await smsSendAllowed(TENANT, { force: true });
  console.log(`\n6) breaker (post-send): ${JSON.stringify(after)}`);
  step("breaker consumed the new verdict", after.sample >= 1, `sample=${after.sample}`);

  finish();
}

function finish(msg = ""): void {
  if (msg) console.log(`\n${msg}`);
  console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\n${failures} STEP(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
