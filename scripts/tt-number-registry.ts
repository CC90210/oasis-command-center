/**
 * scripts/tt-number-registry.ts — discover every TextTorrent sending line we
 * can reach, and score each one on whether the API actually DELIVERS from it.
 *
 * WHY THIS HAS TO EXIST. TT's `/user/number/list` returns 401 for our key
 * (BUSINESS_CONTEXT/TEXTTORRENT_API_VERIFIED.md), so the sending lines cannot
 * be listed. The verified doc's own prescription is to build a registry by
 * acting-as each sub-account and scanning `/inbox` for distinct sender numbers.
 * This is that.
 *
 * WHAT IT IS FOR. Measured 2026-08-12 across 166 outbound messages: API
 * delivery is decided by WHICH LINE SENDS, not by the API being up.
 *
 *     +15614650503   7 delivered   0 failed   <- now unassignable
 *     +13106271134   4 delivered   0 failed   <- now unassignable
 *     +18604071050   0 delivered  21 failed
 *     +15625505490   0 delivered  20 failed
 *     +12173101945   0 delivered   8 failed
 *     +18604527608   0 delivered   4 failed
 *
 * ...while web-UI sends from those SAME lines were 106 delivered / 0 failed.
 * That is the signature of A2P 10DLC campaign registration: carriers gate
 * programmatic traffic per number and let conversational web traffic through.
 *
 * So the question this answers is the only one that matters right now: is there
 * a line we can still send from TODAY that the carrier accepts? If yes, drips
 * resume immediately. If no, nothing moves until TextTorrent registers our
 * numbers, and we know that for certain instead of guessing.
 *
 * READ-ONLY. Discovery reads inboxes. The ownership probe uses
 * `/inbox/chat/create`, which TT documents as FREE and which we only ever call
 * with a receiver that ALREADY has a chat in that context — so no chat is
 * minted and no credit is spent. Nothing is sent.
 *
 * Paced under TT's 60 req/min PARENT-key limit, which is shared with the live
 * Jordan agent — so it deliberately leaves headroom rather than racing it.
 *
 * Run:
 *   node --conditions=react-server --import tsx scripts/tt-number-registry.ts
 *   node --conditions=react-server --import tsx scripts/tt-number-registry.ts --chats 40
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
  if (env.BRAVO_FIELD_ENCRYPTION_KEY) process.env.BRAVO_FIELD_ENCRYPTION_KEY = env.BRAVO_FIELD_ENCRYPTION_KEY;
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
}
loadEnv();

const BASE = "https://api.texttorrent.com/api/v1";
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const CHATS_PER_CONTEXT = Number(
  process.argv[process.argv.indexOf("--chats") + 1] || (process.argv.includes("--chats") ? 30 : 30),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stats = { apiDelivered: number; apiFailed: number; apiPending: number; webDelivered: number; webFailed: number };
type Line = { number: string; seenIn: Set<string>; ownedBy: string[]; stats: Stats; lastSeen: string };

const blank = (): Stats => ({ apiDelivered: 0, apiFailed: 0, apiPending: 0, webDelivered: 0, webFailed: 0 });

async function main(): Promise<void> {
  const tt = await import("../lib/integrations/texttorrent");
  const c = (await tt.getTextTorrentCredentials(TENANT, { service: "texttorrent" })) as unknown as Record<string, string>;
  const sid = c.apiSid ?? c.api_sid;
  const pk = c.publicKey ?? c.api_public_key;
  if (!sid || !pk) {
    console.error("no TextTorrent credentials resolved — is BRAVO_FIELD_ENCRYPTION_KEY present?");
    process.exit(1);
  }

  let calls = 0;
  const req = async (path: string, actAs: string | null, init?: RequestInit) => {
    await sleep(1150); // ~52/min, leaving room for the live Jordan agent
    calls++;
    const headers: Record<string, string> = {
      "X-API-SID": sid,
      "X-API-PUBLIC-KEY": pk,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    };
    if (actAs) headers["X-ACT-AS-USER"] = actAs;
    const res = await fetch(`${BASE}${path}`, { ...init, headers });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, text, json };
  };

  // ── 1. Every context we can act as ───────────────────────────────────────
  const contexts: Array<{ label: string; actAs: string | null }> = [{ label: "parent", actAs: null }];
  const subs = await req("/user/sub-account/list", null);
  const subList = ((subs.json?.data as Record<string, unknown>)?.data ?? subs.json?.data ?? []) as Array<
    Record<string, unknown>
  >;
  for (const s of Array.isArray(subList) ? subList : []) {
    const email = String(s.email ?? "").trim();
    if (email) contexts.push({ label: String(s.first_name ?? email).toLowerCase(), actAs: email });
  }
  console.log(`contexts: ${contexts.map((x) => x.label).join(", ")}\n`);

  // ── 2. Discover lines + delivery stats, per context ──────────────────────
  const lines = new Map<string, Line>();
  /** A receiver that already has a chat in this context, for the free
   *  ownership probe — so we never mint a new chat. */
  const probeReceiver = new Map<string, string>();

  for (const ctx of contexts) {
    const inbox = await req(`/inbox?limit=25`, ctx.actAs);
    const chats = (((inbox.json?.data as Record<string, unknown>)?.data ?? []) as Array<Record<string, unknown>>) || [];
    console.log(`${ctx.label}: ${chats.length} chats in the first page`);
    let scanned = 0;
    for (const ch of chats.slice(0, CHATS_PER_CONTEXT)) {
      const full = await req(`/inbox/${ch.id}`, ctx.actAs);
      const d = (full.json?.data ?? {}) as Record<string, unknown>;
      const chat = (d.chat ?? {}) as Record<string, unknown>;
      const from = String(chat.from_number ?? "").trim();
      const contact = String(chat.number ?? "").replace(/\D/g, "").slice(-10);
      if (contact && !probeReceiver.has(ctx.label)) probeReceiver.set(ctx.label, contact);
      if (!from) continue;

      let e = lines.get(from);
      if (!e) {
        e = { number: from, seenIn: new Set(), ownedBy: [], stats: blank(), lastSeen: "" };
        lines.set(from, e);
      }
      e.seenIn.add(ctx.label);

      const msgs = ((d.messages as Record<string, unknown>)?.data ?? d.messages ?? []) as Array<Record<string, unknown>>;
      for (const m of Array.isArray(msgs) ? msgs : []) {
        if (String(m.direction) !== "outbound") continue;
        const status = String(m.api_send_status ?? "").toLowerCase();
        const isApi = String(m.platform ?? "") === "api";
        const when = String(m.created_at ?? "").slice(0, 10);
        if (when > e.lastSeen) e.lastSeen = when;
        if (isApi) {
          if (status === "delivered" || status === "success") e.stats.apiDelivered++;
          else if (status === "failed") e.stats.apiFailed++;
          else if (status === "pending") e.stats.apiPending++;
        } else {
          if (status === "delivered" || status === "success") e.stats.webDelivered++;
          else if (status === "failed") e.stats.webFailed++;
        }
      }
      scanned++;
    }
    console.log(`  scanned ${scanned}, lines known so far: ${lines.size}`);
  }

  // ── 3. Which context can actually SEND from each line ────────────────────
  console.log(`\nownership probe (free — receiver always has an existing chat)`);
  for (const [num, line] of lines) {
    for (const ctx of contexts) {
      const receiver = probeReceiver.get(ctx.label);
      if (!receiver) continue;
      const r = await req(`/inbox/chat/create`, ctx.actAs, {
        method: "POST",
        body: JSON.stringify({ receiver_number: receiver, sender_id: num }),
      });
      const owns = r.ok || /already started/i.test(r.text);
      if (owns) line.ownedBy.push(ctx.label);
    }
  }

  // ── 4. The verdict ───────────────────────────────────────────────────────
  const verdictOf = (l: Line): string => {
    const assignable = l.ownedBy.length > 0;
    const apiTotal = l.stats.apiDelivered + l.stats.apiFailed;
    if (!assignable) return "UNASSIGNABLE";
    if (l.stats.apiDelivered > 0 && l.stats.apiFailed === 0) return "USABLE";
    if (l.stats.apiDelivered > 0) return "MIXED";
    if (apiTotal === 0) return "UNTESTED";
    return "BURNED";
  };

  const rows = [...lines.values()].sort((a, b) => b.stats.apiDelivered - a.stats.apiDelivered || b.stats.apiFailed - a.stats.apiFailed);
  console.log(`\n${"line".padEnd(15)}${"verdict".padEnd(14)}${"api ok".padStart(7)}${"api fail".padStart(9)}${"web ok".padStart(8)}  owned by`);
  for (const l of rows) {
    console.log(
      `${l.number.padEnd(15)}${verdictOf(l).padEnd(14)}${String(l.stats.apiDelivered).padStart(7)}` +
        `${String(l.stats.apiFailed).padStart(9)}${String(l.stats.webDelivered).padStart(8)}  ${l.ownedBy.join(",") || "-"}`,
    );
  }

  const usable = rows.filter((l) => verdictOf(l) === "USABLE");
  const untested = rows.filter((l) => verdictOf(l) === "UNTESTED");
  console.log(`\n${calls} API calls made.`);
  if (usable.length) {
    console.log(`\n✅ ${usable.length} line(s) both ASSIGNABLE and proven to deliver via API:`);
    for (const l of usable) console.log(`   ${l.number}  (owned by ${l.ownedBy.join(",")}, last seen ${l.lastSeen})`);
    console.log("   -> point the drip engine at these and SMS resumes today.");
  } else {
    console.log(`\n❌ No line is both assignable AND proven to deliver via API.`);
    if (untested.length) {
      console.log(`   ${untested.length} assignable line(s) have NO API history — worth one probe each:`);
      for (const l of untested) console.log(`   ${l.number}  (owned by ${l.ownedBy.join(",")})`);
    }
    console.log("   -> otherwise this is TextTorrent's A2P campaign registration, and only they can move it.");
  }
}

main().catch((err) => {
  console.error("REGISTRY ERROR:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
