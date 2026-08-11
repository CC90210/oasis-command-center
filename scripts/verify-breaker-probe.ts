/**
 * scripts/verify-breaker-probe.ts
 *
 * Proves the half-open probe lease grants EXACTLY ONE winner, against the real
 * database.
 *
 * WHY. The previous version enforced "one probe per 30 minutes" with a
 * process-local cache. On Vercel, dispatch runs concurrently, so every instance
 * saw "probe due" and sent — the guarantee lived in a comment and a unit test
 * while the system could fire several probes into a dead route. The replacement
 * is a conditional UPDATE, and that is exactly the kind of mechanism that
 * silently does not work (a filter PostgREST ignores, an upsert that clobbers
 * the lease). So it gets proven, not asserted.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/verify-breaker-probe.ts
 *
 * Writes only to sms_breaker_probes for the SunBiz tenant. Sends nothing.
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
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const { claimBreakerProbe } = await import("@/lib/sms/send-breaker");
  const { getServiceSupabase } = await import("@/lib/supabase-server");
  const db = getServiceSupabase();

  // Start from a clean lease so the first claim is genuinely due.
  await db.from("sms_breaker_probes").upsert({ tenant_id: TENANT, last_probe_at: "epoch" }, { onConflict: "tenant_id" });

  console.log("sequential:");
  const first = await claimBreakerProbe(TENANT);
  check("the first caller claims the probe", first === true);
  const second = await claimBreakerProbe(TENANT);
  check("the second caller is refused", second === false, "otherwise every dispatch row would probe");

  // The real hazard: concurrent instances, not sequential calls.
  await db.from("sms_breaker_probes").update({ last_probe_at: "epoch" }).eq("tenant_id", TENANT);
  console.log("concurrent (12 racing callers):");
  const results = await Promise.all(Array.from({ length: 12 }, () => claimBreakerProbe(TENANT)));
  const winners = results.filter(Boolean).length;
  check("exactly one winner", winners === 1, `${winners} of 12 claimed`);

  // And it must reopen once the interval passes.
  await db
    .from("sms_breaker_probes")
    .update({ last_probe_at: new Date(Date.now() - 31 * 60_000).toISOString() })
    .eq("tenant_id", TENANT);
  const afterInterval = await claimBreakerProbe(TENANT);
  check("a stale lease can be reclaimed", afterInterval === true, "otherwise the breaker wedges shut");

  // Leave the lease claimable so a real halt is not delayed by this run.
  await db.from("sms_breaker_probes").update({ last_probe_at: "epoch" }).eq("tenant_id", TENANT);

  console.log(failures === 0 ? "\nPROBE LEASE VERIFIED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
