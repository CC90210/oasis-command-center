/**
 * scripts/audit-texttorrent.ts — is the TextTorrent integration actually able
 * to send, and if not, exactly where does it break?
 *
 * Adon, 2026-08-12: "audit that issue. Ensure that at the end of the day we
 * have a seamless connection and we're able to send out text messages, even
 * text blasts, using the API to its maximum use."
 *
 * THE STANDING DIAGNOSIS MAY BE WRONG. Since 2026-08-07 the working theory has
 * been that TT's API route is refused by the carrier (SignalHouse) while their
 * web UI delivers. But texttorrent.ts carries a second explanation written
 * during the 2026-07-23 incident: `/inbox/chat/create` is FREE and returns 201
 * even at a ZERO balance, while the billable `/inbox/chat` send 422s with
 * insufficient_credits. A drained account therefore looks exactly like a
 * refused API route from the outside — 201s, no delivery.
 *
 * 20 of 20 receipts have failed and 0 delivered, so something is systematically
 * wrong. This separates the candidates by ASKING TT rather than inferring:
 *
 *   1. do the credentials authenticate at all
 *   2. what is the credit balance          <- the cheap explanation
 *   3. which sender numbers does TT think we have
 *   4. what does TT say about our recent messages (api_send_status)
 *   5. is the send breaker currently halting us locally
 *
 * READ-ONLY BY DEFAULT. Nothing here sends or spends a credit. Pass --probe
 * with an explicit --to number to attempt ONE real 1-segment send (3 credits)
 * once the read-only findings justify it.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/audit-texttorrent.ts
 *   node --conditions=react-server --import tsx scripts/audit-texttorrent.ts --probe --to +15551234567
 */

import { readFileSync } from "node:fs";

function loadEnv(): void {
  let txt = "";
  try {
    txt = readFileSync("C:/Users/echel/JARVIS/.env.agents", "utf8");
  } catch {
    return;
  }
  const env: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    env[k.trim()] = rest.join("=").trim().replace(/^"|"$/g, "");
  }
  if (env.TURSO_BRAVO_EMPIRE_URL) process.env.TURSO_DATABASE_URL = env.TURSO_BRAVO_EMPIRE_URL;
  if (env.TURSO_AUTH_TOKEN) process.env.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
  // Integration credentials are stored encrypted at rest; without this key the
  // decrypt fails per-field and the bundle looks like "not on file", which is a
  // misleading error for what is actually a missing local key.
  if (env.BRAVO_FIELD_ENCRYPTION_KEY) process.env.BRAVO_FIELD_ENCRYPTION_KEY = env.BRAVO_FIELD_ENCRYPTION_KEY;
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
}
loadEnv();

const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const argv = process.argv.slice(2);
const PROBE = argv.includes("--probe");
const TO = (() => {
  const i = argv.indexOf("--to");
  return i >= 0 ? argv[i + 1] : "";
})();

const findings: string[] = [];
const say = (s: string) => console.log(s);
const finding = (s: string) => {
  findings.push(s);
  console.log(`  >> ${s}`);
};

async function main(): Promise<void> {
  say("TEXTTORRENT INTEGRATION AUDIT — read-only unless --probe\n");

  const tt = await import("../lib/integrations/texttorrent");

  // ── 1. Credentials ───────────────────────────────────────────────────────
  say("=== 1. Credentials ===");
  let creds: Awaited<ReturnType<typeof tt.getTextTorrentCredentials>> | null = null;
  for (const service of ["texttorrent", "texttorrent_followup"]) {
    try {
      const c = await tt.getTextTorrentCredentials(TENANT, { service });
      say(`  ok    ${service}: SID + public key on file`);
      if (service === "texttorrent") creds = c;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      say(`  --    ${service}: ${msg.slice(0, 90)}`);
      if (service === "texttorrent") finding(`main TT credentials unavailable: ${msg.slice(0, 120)}`);
    }
  }
  if (!creds) {
    say("\nCannot continue without main credentials.");
    process.exit(1);
  }

  // ── 2. Balance — the cheap explanation ───────────────────────────────────
  say("\n=== 2. Account + credit balance ===");
  try {
    const me = (await tt.meAccountInfo(creds)) as Record<string, unknown>;
    // TT nests differently across responses; print what we got rather than
    // assuming a shape that may have drifted.
    const flat = JSON.stringify(me).slice(0, 600);
    say(`  raw: ${flat}`);
    const findNum = (obj: unknown, keys: string[]): number | null => {
      const seen = new Set<unknown>();
      const walk = (o: unknown): number | null => {
        if (!o || typeof o !== "object" || seen.has(o)) return null;
        seen.add(o);
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (keys.includes(k.toLowerCase())) {
            const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
            if (Number.isFinite(n)) return n;
          }
          const nested = walk(v);
          if (nested !== null) return nested;
        }
        return null;
      };
      return walk(obj);
    };
    const bal = findNum(me, ["credit", "credits", "balance", "credit_balance", "available_credit"]);
    if (bal === null) {
      finding("could not locate a credit balance in TT's /me response — shape may have changed");
    } else {
      say(`  credit balance: ${bal}`);
      if (bal <= 0) {
        finding(`ACCOUNT IS OUT OF CREDITS (${bal}). Every billable send 422s while free chat-creates still return 201 — which looks identical to a carrier refusal from our side.`);
      } else if (bal < 500) {
        finding(`credit balance is LOW (${bal}); at 3 credits/recipient that is ~${Math.floor(bal / 3)} more messages.`);
      } else {
        say(`  -> credits are NOT the blocker (~${Math.floor(bal / 3)} messages of headroom)`);
      }
    }
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number };
    finding(`/me failed: ${e.code || ""} ${e.message || String(err)} (http ${e.status ?? "?"})`);
  }

  // ── 3. Sender numbers ────────────────────────────────────────────────────
  say("\n=== 3. Sender numbers TT knows about ===");
  // Read the numbers off recent OUTBOUND traffic rather than a directory
  // endpoint: what matters is which lines we are actually sending from.
  try {
    const inbox = await tt.getInbox(creds);
    const rows = (Array.isArray(inbox) ? inbox : ((inbox as { data?: unknown[] })?.data ?? [])) as Array<
      Record<string, unknown>
    >;
    const froms = new Set<string>();
    for (const r of rows) {
      const f = String(r.to ?? r.from_number ?? "").trim();
      if (f) froms.add(f);
    }
    say(`  sending lines seen in the last ${rows.length} threads: ${[...froms].join(", ") || "(none)"}`);
  } catch (err) {
    say(`  could not enumerate: ${(err as Error).message.slice(0, 100)}`);
  }

  // ── 4. What TT says about our recent messages ────────────────────────────
  //
  // getThreadRaw, NOT getThread. The normalized shape drops api_send_status,
  // which is the only field that carries the CARRIER's verdict — TT returns
  // HTTP 201 for a message SignalHouse then refuses, so our own 201 proves
  // nothing. This tallies platform against that verdict, because the whole
  // question is whether the API path behaves differently from the web UI on
  // the same lines.
  say("\n=== 4. TT's own verdict on recent messages (api_send_status) ===");
  try {
    const inbox = await tt.getInbox(creds);
    const threads = (Array.isArray(inbox) ? inbox : ((inbox as { data?: unknown[] })?.data ?? [])) as Array<
      Record<string, unknown>
    >;
    const tally = new Map<string, number>();
    let outbound = 0;
    let noReason = 0;
    for (const t of threads.slice(0, 30)) {
      const chatId = String(t.chat_id ?? t.id ?? "");
      if (!chatId) continue;
      let msgs: Array<Record<string, unknown>> = [];
      try {
        const raw = await tt.getThreadRaw(creds, chatId);
        msgs = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? [])) as Array<
          Record<string, unknown>
        >;
      } catch {
        continue;
      }
      for (const m of msgs) {
        if (String(m.direction) !== "outbound") continue;
        outbound++;
        const platform = String(m.platform ?? "?");
        const status = String(m.api_send_status ?? "?").toLowerCase();
        const seg = String(m.segment ?? "?");
        tally.set(`${platform} seg${seg} -> ${status}`, (tally.get(`${platform} seg${seg} -> ${status}`) || 0) + 1);
        if (status === "failed" && !m.api_receive_response) noReason++;
      }
    }
    say(`  outbound messages examined: ${outbound}`);
    for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) say(`    ${String(v).padStart(4)}  ${k}`);

    const apiFailed = [...tally.entries()].filter(([k]) => k.startsWith("api") && k.endsWith("failed")).reduce((s2, [, v]) => s2 + v, 0);
    const apiOk = [...tally.entries()].filter(([k]) => k.startsWith("api") && /delivered|success/.test(k)).reduce((s2, [, v]) => s2 + v, 0);
    const webOk = [...tally.entries()].filter(([k]) => !k.startsWith("api") && /delivered|success/.test(k)).reduce((s2, [, v]) => s2 + v, 0);
    if (apiFailed > 0 && apiOk > 0) {
      finding(`the API path is NOT uniformly broken — ${apiOk} delivered against ${apiFailed} failed in this sample. Something distinguishes the failing sends from the succeeding ones; it is not simply "the API route".`);
    } else if (apiFailed > 0 && apiOk === 0 && webOk > 0) {
      finding(`every API send failed (${apiFailed}) while ${webOk} web/app sends delivered on the same account — the difference is the submission path, not the numbers or their registration.`);
    }
    if (noReason > 0) {
      finding(`${noReason} failed message(s) carry NO api_receive_response, so TT is not surfacing SignalHouse's rejection reason. That reason has to come from TT support — we cannot derive it.`);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string; status?: number };
    finding(`inbox read failed: ${e.code || ""} ${e.message || String(err)} (http ${e.status ?? "?"})`);
  }

  // ── 5. Our own breaker ───────────────────────────────────────────────────
  say("\n=== 5. Local send breaker ===");
  try {
    const { smsSendAllowed } = await import("../lib/sms/send-breaker");
    const verdict = await smsSendAllowed(TENANT);
    say(`  ${JSON.stringify(verdict)}`);
    if ((verdict as { halt?: boolean }).halt) {
      finding("the local SMS breaker is HALTING sends — it has seen too many consecutive carrier failures. It self-heals via a half-open probe, but nothing will flow until a probe succeeds.");
    }
  } catch (err) {
    say(`  breaker check failed: ${(err as Error).message.slice(0, 120)}`);
  }

  // ── 6. Optional live probe ───────────────────────────────────────────────
  if (PROBE) {
    say("\n=== 6. LIVE PROBE (spends ~3 credits) ===");
    if (!TO) {
      say("  refusing: --probe needs --to <e164>");
    } else {
      try {
        const res = await tt.sendSms(creds, {
          number: TO,
          message: `APEX integration probe ${new Date().toISOString().slice(11, 19)}Z. Reply STOP to opt out.`,
        } as never);
        say(`  send returned: ${JSON.stringify(res)}`);
        finding("probe accepted by the API — check api_send_status on that chat in a few minutes for the CARRIER verdict, which is the number that matters.");
      } catch (err) {
        const e = err as { code?: string; message?: string; status?: number };
        finding(`probe REJECTED: ${e.code || ""} ${e.message || String(err)} (http ${e.status ?? "?"})`);
      }
    }
  } else {
    say("\n=== 6. Live probe skipped (add --probe --to <e164>) ===");
  }

  say(`\n${findings.length} finding(s)`);
  for (const f of findings) say(`  - ${f}`);
}

main().catch((err) => {
  console.error("AUDIT ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
