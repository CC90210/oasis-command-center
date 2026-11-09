import assert from "node:assert/strict";
import { sendTelegram } from "../lib/notify/telegram";
async function main() {
  const original = globalThis.fetch;
  const target = { token: "synthetic", chatId: "synthetic" };
  try {
    globalThis.fetch = (async () => Response.json({ ok: true, result: { message_id: 123 } })) as typeof fetch;
    const delivered = await sendTelegram("synthetic", target);
    assert.equal(delivered.ok, true); assert.equal(delivered.providerMessageId, 123);
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    assert.equal((await sendTelegram("synthetic", target)).delivery, "unknown", "HTTP 200 without provider receipt is not delivery");
    globalThis.fetch = (async () => Response.json({ ok: false, description: "synthetic refusal" }, { status: 403 })) as typeof fetch;
    assert.equal((await sendTelegram("synthetic", target)).delivery, "rejected");
    globalThis.fetch = (async () => { throw new Error("https://api.telegram.org/botDO-NOT-LOG/sendMessage timed out"); }) as typeof fetch;
    const uncertain = await sendTelegram("synthetic", target);
    assert.equal(uncertain.delivery, "unknown"); assert.equal(uncertain.reason, "telegram_ack_unverified");
    console.log("telegram-receipts: OK");
  } finally { globalThis.fetch = original; }
}
main().catch((error) => { console.error(error); process.exit(1); });
