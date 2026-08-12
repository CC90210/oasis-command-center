/**
 * tests/telegram-lane-fallback.test.ts — one dead chat must not mean silence.
 *
 * On 2026-08-12 @KnutRPEbot's membership of the SunBiz ops group read
 * `Forbidden: bot was kicked from the group chat`. Telegram gives a bot no way
 * to re-add itself, so every sunbiz-ops alert was undeliverable until a human
 * acted — and the ten-day SMS outage alerted into that void for five days. The
 * detection worked perfectly. The delivery was the single point of failure.
 *
 * The fix adds a SECOND chat within the same lane. These assertions pin the two
 * things that make it safe rather than just convenient:
 *
 *   1. it must never widen the AUDIENCE — the whole module exists because one
 *      implicit default served two audiences and leaked CC's leads into Adon's
 *      DM for 34 days;
 *   2. a delivery that only succeeded on the fallback must still REPORT that
 *      the primary is broken, or the dead group stays dead forever.
 */

import assert from "node:assert/strict";

const TOKEN = "test-token";
const GROUP = "-100200300";
const DM = "7979676345";

process.env.SUNBIZ_OPS_TELEGRAM_BOT_TOKEN = TOKEN;
process.env.SUNBIZ_OPS_TELEGRAM_CHAT_ID = GROUP;
process.env.SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID = DM;
process.env.OASIS_TELEGRAM_BOT_TOKEN = "cc-token";
process.env.OASIS_TELEGRAM_CHAT_ID = "555000";

type Sent = { chatId: string; token: string; text: string };

/** Swap in a fetch that records every call and fails whichever chats we name. */
function stubFetch(failing: Set<string>): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const token = u.match(/\/bot([^/]+)\//)?.[1] ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    const chatId = String(body.chat_id ?? "");
    sent.push({ chatId, token, text: String(body.text ?? "") });
    if (failing.has(chatId)) {
      return new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was kicked from the group chat" }), {
        status: 403,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function main(): Promise<void> {
  const { sendTelegram } = await import("../lib/notify/telegram");

  // ── Healthy primary: the fallback is never touched ──────────────────────
  {
    const { sent, restore } = stubFetch(new Set());
    const res = await sendTelegram("all good", { lane: "sunbiz-ops" });
    restore();
    assert.equal(res.ok, true);
    assert.equal(res.degraded, undefined, "a healthy send is not degraded");
    assert.equal(sent.length, 1, "exactly one send when the primary works");
    assert.equal(sent[0].chatId, GROUP);
  }

  // ── Primary kicked: the fallback carries it ─────────────────────────────
  {
    const { sent, restore } = stubFetch(new Set([GROUP]));
    const res = await sendTelegram("SMS carrier failures: 14", { lane: "sunbiz-ops" });
    restore();
    assert.equal(res.ok, true, "a human was reached, so this is not a failure");
    assert.equal(res.degraded, true, "...but the channel they should be using is broken");
    assert.match(String(res.reason), /kicked/, "and the reason names WHY the primary failed");

    assert.equal(sent.length, 2, "primary attempted first, then the fallback");
    assert.equal(sent[0].chatId, GROUP);
    assert.equal(sent[1].chatId, DM);
    // The alert itself must survive the wrapper, or the fallback delivers a
    // notice about a problem without the problem.
    assert.match(sent[1].text, /SMS carrier failures: 14/);
    assert.match(sent[1].text, /Primary alert channel unreachable/);
    assert.match(sent[1].text, /needs the bot re-added/, "it must say what a human has to DO");
  }

  // ── Both down: honest failure, both reasons ─────────────────────────────
  {
    const { sent, restore } = stubFetch(new Set([GROUP, DM]));
    const res = await sendTelegram("x", { lane: "sunbiz-ops" });
    restore();
    assert.equal(res.ok, false, "no human was reached, so this IS a failure");
    assert.match(String(res.reason), /fallback also failed/);
    assert.equal(sent.length, 2);
  }

  // ── The audience never widens ───────────────────────────────────────────
  // The module exists because one default served two audiences. A fallback that
  // could reach CC would reintroduce exactly that, so the operator lane has no
  // fallback configured and must fail rather than borrow one.
  {
    const { sent, restore } = stubFetch(new Set(["555000"]));
    const res = await sendTelegram("CC's lead", { lane: "operator" });
    restore();
    assert.equal(res.ok, false, "the operator lane fails rather than finding another address");
    assert.equal(sent.length, 1, "no second attempt");
    assert.ok(!sent.some((s) => s.chatId === DM), "CC's alert must NEVER reach Adon's DM");
  }

  // ── An explicit per-user target gets no fallback ────────────────────────
  // A message addressed to one named person must not be re-sent to someone
  // else because that person's chat was closed.
  {
    const { sent, restore } = stubFetch(new Set(["999"]));
    const res = await sendTelegram("your lead", { token: TOKEN, chatId: "999" });
    restore();
    assert.equal(res.ok, false);
    assert.equal(sent.length, 1, "an explicitly addressed message is never redirected");
  }

  // ── A fallback equal to the primary is not a second address ─────────────
  {
    process.env.SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID = GROUP;
    const { sent, restore } = stubFetch(new Set([GROUP]));
    const res = await sendTelegram("x", { lane: "sunbiz-ops" });
    restore();
    process.env.SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID = DM;
    assert.equal(res.ok, false);
    assert.equal(sent.length, 1, "retrying the same dead chat is not a fallback");
  }

  console.log("telegram-lane-fallback.test.ts — all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
