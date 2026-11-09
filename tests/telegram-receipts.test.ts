import assert from "node:assert/strict";
import { parseRetryAfter, sendTelegram } from "../lib/notify/telegram";
async function main() {
  const original = globalThis.fetch;
  const target = { token: "synthetic", chatId: "synthetic" };
  try {
    globalThis.fetch = (async () => Response.json({ ok: true, result: { message_id: 123 } })) as typeof fetch;
    const delivered = await sendTelegram("synthetic", target);
    assert.equal(delivered.ok, true); assert.equal(delivered.providerMessageId, 123);
    for (const id of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      globalThis.fetch = (async () => Response.json({ ok: true, result: { message_id: id } })) as typeof fetch;
      assert.equal((await sendTelegram("synthetic", target)).delivery, "unknown", "only a positive safe provider ID confirms delivery");
    }
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    assert.equal((await sendTelegram("synthetic", target)).delivery, "unknown", "HTTP 200 without provider receipt is not delivery");
    globalThis.fetch = (async () => Response.json({ ok: false, description: "synthetic refusal" }, { status: 403 })) as typeof fetch;
    assert.equal((await sendTelegram("synthetic", target)).delivery, "rejected");
    assert.equal((await sendTelegram("synthetic", target)).permanent, true);
    for (const status of [401, 403]) {
      globalThis.fetch = (async () => Response.json({ ok: false }, { status })) as typeof fetch;
      assert.equal((await sendTelegram("synthetic", target)).permanent, true);
    }
    globalThis.fetch = (async () => Response.json({ ok: false, parameters: { retry_after: 600 } },
      { status: 429, headers: { "retry-after": "120" } })) as typeof fetch;
    const limited = await sendTelegram("synthetic", target);
    assert.equal(limited.delivery, "rejected"); assert.equal(limited.retryAfterMs, 600_000);
    assert.ok(limited.retryAtMs! >= Date.now() + 599_000);
    assert.equal(limited.permanent, undefined);
    assert.equal(parseRetryAfter({ parameters: { retry_after: 120 } }, "600"), 600_000);
    const now = Date.parse("2026-11-09T12:00:00Z");
    assert.equal(parseRetryAfter(null, "Mon, 09 Nov 2026 12:10:00 GMT", now), 600_000);
    assert.equal(parseRetryAfter({}, "invalid", now), 60_000);
    const realNow = Date.now;
    let clock = now;
    try {
      Date.now = () => clock;
      globalThis.fetch = (async () => {
        clock += 5_000;
        return Response.json({ ok: false, parameters: { retry_after: 600 } }, { status: 429 });
      }) as typeof fetch;
      assert.equal((await sendTelegram("synthetic", target)).retryAtMs, now + 605_000, "provider response time owns the absolute deadline");
    } finally { Date.now = realNow; }
    globalThis.fetch = (async () => { throw new Error("https://api.telegram.org/botDO-NOT-LOG/sendMessage timed out"); }) as typeof fetch;
    const uncertain = await sendTelegram("synthetic", target);
    assert.equal(uncertain.delivery, "unknown"); assert.equal(uncertain.reason, "telegram_ack_unverified");
    console.log("telegram-receipts: OK");
  } finally { globalThis.fetch = original; }
}
main().catch((error) => { console.error(error); process.exit(1); });
