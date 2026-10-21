/**
 * Telegram lane cutoff contract (2026-10-21).
 *
 * Former external-lane credentials may remain in a stale deployment without
 * granting delivery. OASIS sales uses CC's dedicated credential pair and fails
 * closed instead of borrowing the generic bot/chat pair.
 */
import assert from "node:assert/strict";

const OASIS_CHAT = "555000";
const GENERIC_CHAT = "666000";

process.env.SUNBIZ_OPS_TELEGRAM_BOT_TOKEN = "former-token";
process.env.SUNBIZ_OPS_TELEGRAM_CHAT_ID = "-100200300";
process.env.SUNBIZ_OPS_TELEGRAM_FALLBACK_CHAT_ID = "7979676345";
process.env.OASIS_TELEGRAM_BOT_TOKEN = "cc-token";
process.env.OASIS_TELEGRAM_CHAT_ID = OASIS_CHAT;
process.env.TELEGRAM_BOT_TOKEN = "generic-token";
process.env.TELEGRAM_CHAT_ID = GENERIC_CHAT;

type Sent = { chatId: string; token: string; text: string };

function stubFetch(): { sent: Sent[]; restore: () => void } {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const token = String(url).match(/\/bot([^/]+)\//)?.[1] ?? "";
    const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string; text?: string };
    sent.push({ chatId: String(body.chat_id ?? ""), token, text: String(body.text ?? "") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function main(): Promise<void> {
  const { sendTelegram } = await import("../lib/notify/telegram");

  {
    const { sent, restore } = stubFetch();
    const res = await sendTelegram("former lane", { lane: "sunbiz-ops" });
    restore();
    assert.equal(res.ok, false, "a retired external lane became deliverable");
    assert.equal(sent.length, 0, "stale former-lane credentials were used");
  }

  {
    const { sent, restore } = stubFetch();
    const res = await sendTelegram("new lead", { lane: "sales" });
    restore();
    assert.equal(res.ok, true);
    assert.deepEqual(sent.map(({ chatId, token }) => ({ chatId, token })), [
      { chatId: OASIS_CHAT, token: "cc-token" },
    ]);
  }

  {
    delete process.env.OASIS_TELEGRAM_BOT_TOKEN;
    delete process.env.OASIS_TELEGRAM_CHAT_ID;
    const { sent, restore } = stubFetch();
    const res = await sendTelegram("must fail closed", { lane: "sales" });
    restore();
    assert.equal(res.ok, false, "sales borrowed generic Telegram credentials");
    assert.equal(sent.length, 0, "sales reached a generic chat after CC's pair was removed");
    assert.ok(!sent.some((item) => item.chatId === GENERIC_CHAT));
  }

  console.log("telegram-lane-fallback.test.ts — retired lanes disabled; OASIS sales fails closed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
